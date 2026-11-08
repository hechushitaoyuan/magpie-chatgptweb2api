import { appendFile, readFile } from "node:fs/promises";
import { BrowserBridge } from "./bridge.js";
import { BASE_URL, PROVIDER, parseOptions, type Options } from "./options.js";
import { completionResponse, prepare, type BrowserEvent, type Completion } from "./protocol.js";
import { WebError, errorBody, publicError, checkAbort } from "./errors.js";
import { cookieFilePath } from "./cookies.js";
import { type ImageRequest, type ImageResult } from "./image.js";
import { materializeReferences, referenceParts, referenceValues } from "./references.js";
import { tool } from "@opencode-ai/plugin";

/** The model id the gateway and agents use for the webpage's picture ability. */
export const IMAGE_MODEL = "web-image";

export interface Auth { type: string; key?: string; metadata?: Record<string, unknown> }
export interface Runtime {
  call<T>(method: "loginBegin" | "cookieBegin" | "loginWait" | "guestBegin" | "guestWait" | "status", params: unknown, signal?: AbortSignal): Promise<T>;
  open(profileId: string, completion: Completion, signal?: AbortSignal): Promise<AsyncIterableIterator<BrowserEvent>>;
  close(): Promise<void>;
  generateImage?(profileId: string, request: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
}
function profileOf(auth?: Auth): string {
  if (auth?.type !== "api" || !auth.key?.startsWith("browser:")) throw new WebError("Sign in using the ChatGPT Web browser method", 401, "sign_in_required");
  const id = auth.key.slice("browser:".length);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new WebError("Invalid browser account association; sign in again", 401, "invalid_profile");
  return id;
}

function modelList(options: Options) {
  const models: Record<string, unknown> = Object.fromEntries(options.models.map(m => [m.id, {
    id: m.id, name: m.label, api: { id: m.id, url: BASE_URL, npm: "@ai-sdk/openai-compatible" },
    limit: { context: options.contextLimit, output: options.outputLimit },
    // Magpie reads a config model's own modalities as well as its capabilities; both are said
    // here so the picture model is not mistaken for a text one.
    modalities: { input: ["text"], output: ["text"] },
    capabilities: { reasoning: false, toolcall: false, attachment: false, input: { text: true, image: false }, output: { text: true } },
  }]));
  // The picture ability is the same logged-in browser session, declared as one more model whose
  // output is an image: Magpie reads that as an image model, so it reaches Settings → Images and
  // `generate_image --model`, and its requests arrive here on the OpenAI Images API.
  models[IMAGE_MODEL] = {
    id: IMAGE_MODEL, name: "ChatGPT Web · 网页生图", api: { id: IMAGE_MODEL, url: BASE_URL, npm: "@ai-sdk/openai-compatible" },
    limit: { context: options.contextLimit, output: options.outputLimit },
    modalities: { input: ["text"], output: ["text", "image"] },
    capabilities: { reasoning: false, toolcall: false, attachment: false, input: { text: true, image: false }, output: { text: true, image: true } },
  };
  return models;
}

interface ImagesBody { model?: unknown; prompt?: unknown; n?: unknown; size?: unknown; quality?: unknown }

/** Whether the caller asked for an event stream. */
function wantsStream(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try { return (JSON.parse(body) as { stream?: unknown }).stream === true; } catch { return false; }
}

/** The model id a raw request body names, read before the text validation would reject it. */
function requestedModel(body: unknown): string {
  if (typeof body !== "string") return "";
  try { const q = JSON.parse(body) as { model?: unknown }; return typeof q?.model === "string" ? q.model : ""; } catch { return ""; }
}

/** The words Magpie (or an agent) asked to be drawn, from either request shape. */
function promptOf(body: unknown): string {
  if (typeof body !== "string") return "";
  let q: Record<string, unknown>;
  try { q = JSON.parse(body) as Record<string, unknown>; } catch { return ""; }
  if (!q || typeof q !== "object") return "";
  if (typeof q.prompt === "string" && q.prompt.trim()) return q.prompt;
  const messages = Array.isArray(q.messages) ? q.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim()) return message.content;
    if (Array.isArray(message.content)) {
      const text = (message.content as { type?: string; text?: string }[])
        .filter(part => part?.type === "text" && typeof part.text === "string")
        .map(part => part.text as string).join("\n").trim();
      if (text) return text;
    }
  }
  return "";
}

/**
 * The gateway asks an image model on the Chat Completions API and reads the picture out of the
 * reply, so the assistant message carries a `data:` `image_url` content part beside its text.
 * Verified against Magpie 0.1.3251: `POST /v1/images/generations {model:"chatgpt-web/web-image"}`
 * arrives here as `{model:"web-image", messages:[…], modalities:["image","text"],
 * image_config:{aspect_ratio}}` and the gateway answers `{created,data:[{b64_json,mime_type}]}`.
 */
async function imageCompletion(bridge: Runtime, profileId: string, body: unknown, options: Options, signal?: AbortSignal): Promise<Response> {
  const prompt = promptOf(body);
  if (!prompt) throw new WebError("The image request carried no prompt", 400, "missing_prompt");
  let requested: { size?: unknown; n?: unknown; quality?: unknown; image_config?: { aspect_ratio?: unknown } } = {};
  try { requested = JSON.parse(String(body)) as typeof requested; } catch { /* the prompt check above already covers a broken body */ }
  // Magpie puts the caller's size in image_config and appends its own "Aspect ratio: …" line, so
  // the plugin adds no second one: it only forwards the ratio it was given.
  const statedRatio = requested.image_config?.aspect_ratio;
  const size = typeof requested.size === "string" && requested.size && requested.size !== "auto"
    ? requested.size
    : typeof statedRatio === "string" && statedRatio ? statedRatio : undefined;
  if (!bridge.generateImage) throw new WebError("This runtime cannot generate images", 501, "images_unsupported");
  const references = await materializeReferences(referenceParts(body));
  let result;
  try {
    result = await bridge.generateImage(profileId, {
    prompt,
    outputDir: options.imageDir,
    ...(typeof requested.n === "number" && Number.isSafeInteger(requested.n) && requested.n >= 1 && requested.n <= 4 ? { n: requested.n } : {}),
    ...(size ? { size, sizeHint: !statedRatio } : {}),
    ...(typeof requested.quality === "string" && requested.quality !== "auto" ? { quality: requested.quality } : {}),
    ...(references.files.length ? { references: references.files } : {}),
    }, signal);
  } finally { await references.cleanup(); }
  // The picture travels inside the assistant text as a Markdown data-URL image. That is how the
  // working Google AI Studio backend answers the same question, and it is the one shape both the
  // gateway's Images API and its Gemini-native generateContent route read back out.
  const drawings: string[] = [];
  for (const [index, image] of result.images.entries()) {
    const data = (await readFile(image.path)).toString("base64");
    drawings.push(`![generated image ${index + 1}](data:${image.mimeType};base64,${data})`);
  }
  const content = [(result.text || "").trim(), ...drawings].filter(Boolean).join("\n\n");
  const id = `chatcmpl-web-image-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const webpage = {
    modelLabel: result.modelLabel, elapsedMs: result.elapsedMs, warnings: result.warnings,
    local_paths: result.images.map(image => image.path),
  };
  // Gemini's native generateContent route asks for a stream even though nothing streams here: the
  // picture exists only once the webpage has finished drawing, so the answer is buffered and then
  // framed as ordinary chat-completion chunks.
  if (wantsStream(body)) {
    const encoder = new TextEncoder();
    const frame = (delta: unknown, finish: string | null = null) =>
      encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: IMAGE_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ role: "assistant", content: "" }));
        if (content) controller.enqueue(frame({ content }));
        controller.enqueue(frame({}, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
  }
  return Response.json({
    id, object: "chat.completion", created, model: IMAGE_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    _webpage: webpage,
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * OpenAI Images API in, the webpage's picture out. Always base64: this plugin serves no files
 * over HTTP, so `local_path` is an extra field beside the standard `b64_json`.
 */
async function imagesResponse(bridge: Runtime, profileId: string, body: unknown, options: Options, signal?: AbortSignal): Promise<Response> {
  if (typeof body !== "string") throw new WebError("Expected a JSON request body", 400, "invalid_body");
  let q: ImagesBody;
  try { q = JSON.parse(body) as ImagesBody; } catch { throw new WebError("Invalid JSON", 400, "invalid_json"); }
  if (!q || typeof q !== "object" || Array.isArray(q)) throw new WebError("Expected a JSON object", 400, "invalid_body");
  if (typeof q.prompt !== "string" || !q.prompt.trim()) throw new WebError("prompt must be a nonempty string", 400, "missing_prompt");
  const n = q.n === undefined ? 1 : q.n;
  if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > 4) throw new WebError("n must be 1–4", 400, "invalid_count");
  if (q.size !== undefined && typeof q.size !== "string") throw new WebError("size must be a string", 400, "invalid_size");
  if (q.quality !== undefined && (typeof q.quality !== "string" || !["auto", "low", "medium", "high"].includes(q.quality))) throw new WebError("quality must be auto, low, medium or high", 400, "unsupported_parameter");
  if (q.model !== undefined && typeof q.model !== "string") throw new WebError("model must be a string", 400, "unknown_model");
  if (!bridge.generateImage) throw new WebError("This runtime cannot generate images", 501, "images_unsupported");
  const references = await materializeReferences(referenceValues(q));
  let result;
  try {
    result = await bridge.generateImage(profileId, {
      prompt: q.prompt,
      outputDir: options.imageDir,
      n: n as number,
      ...(typeof q.size === "string" && q.size && q.size !== "auto" ? { size: q.size } : {}),
      ...(typeof q.quality === "string" && q.quality !== "auto" ? { quality: q.quality } : {}),
      ...(references.files.length ? { references: references.files } : {}),
    }, signal);
  } finally { await references.cleanup(); }
  const data = [];
  for (const image of result.images) {
    data.push({
      b64_json: (await readFile(image.path)).toString("base64"),
      mime_type: image.mimeType,
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {}),
      local_path: image.path,
    });
  }
  return Response.json({
    created: Math.floor(Date.now() / 1000),
    model: IMAGE_MODEL,
    data,
    _webpage: { modelLabel: result.modelLabel, elapsedMs: result.elapsedMs, warnings: result.warnings },
  }, { headers: { "cache-control": "no-store" } });
}

export function createPluginHooks(input: unknown = {}, runtime?: Runtime) {
  const options = parseOptions(input);
  const bridge = runtime ?? new BrowserBridge(options);
  let cachedGetAuth: (() => Promise<Auth>) | undefined;
  const getAuthForTool = async (): Promise<Auth> => {
    if (!cachedGetAuth) throw new WebError("Connect the ChatGPT Web provider first, then sign in", 401, "sign_in_required");
    return await cachedGetAuth();
  };
  const remoteInstructions = options.remoteLoginUrl ? ` 远程专用浏览器：${options.remoteLoginUrl}（需预先配置访问保护）。` : "";
  const close = () => { void bridge.close(); };
  process.stdin.once("end", close);
  return {
    config: async (cfg: { provider?: Record<string, unknown> }) => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] = { name: "ChatGPT Web", npm: "@ai-sdk/openai-compatible", api: BASE_URL, models: modelList(options) };
    },
    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      methods: [{
        type: "oauth", label: "手动登录 ChatGPT（推荐）",
        async authorize() {
          const { profileId } = await bridge.call<{ profileId: string }>("loginBegin", {});
          return {
            url: "", method: "auto",
            instructions: `请在专用浏览器中手动登录 ChatGPT，密码、验证码和 Google 登录都在网页完成。确认账号和输入框后会保存关联；保持窗口模式会保留窗口，后续请求使用独立标签页。账号已登录不代表文本调用已验证。专用 profile: ${profileId}${remoteInstructions}`,
            async callback() {
              try {
                const status = await bridge.call<{ authenticated: boolean; accountId?: string }>("loginWait", { profileId });
                if (!status.authenticated) return { type: "failed", error: "ChatGPT 登录尚未完成" };
                // Magpie stores an opaque local profile association, not a web token.
                return { type: "success", key: `browser:${profileId}`, metadata: { profileId, email: status.accountId } };
              } catch (e) { return { type: "failed", error: publicError(e).message }; }
            },
          };
        },
      }, {
        type: "oauth", label: "匿名网页会话（无需登录）",
        async authorize() {
          const { profileId } = await bridge.call<{ profileId: string }>("guestBegin", {});
          return {
            url: "", method: "auto",
            instructions: "正在验证匿名网页聊天。无需登录；若网页要求验证，请在插件浏览器中处理。" + remoteInstructions,
            async callback() {
              try {
                const status = await bridge.call<{ ready?: boolean }>("guestWait", { profileId });
                if (!status.ready) return { type: "failed", error: "匿名聊天尚不可用" };
                return { type: "success", key: `browser:${profileId}`, metadata: { profileId, email: "匿名网页", mode: "guest" } };
              } catch (e) { return { type: "failed", error: publicError(e).message }; }
            },
          };
        },
      }, {
        type: "oauth", label: "导入 ChatGPT Cookie（本地文件）",
        prompts: [{
          type: "text", key: "cookieFile", message: "Cookie 文件的本机绝对路径（JSON 或请求头文本）",
          placeholder: "~/Downloads/chatgpt.cookies.json",
          validate(value: string) {
            try { cookieFilePath(value); return undefined; }
            catch (e) { return publicError(e).message; }
          },
        }],
        async authorize(inputs: Record<string, string> = {}) {
          const file = cookieFilePath(inputs.cookieFile);
          const { profileId } = await bridge.call<{ profileId: string }>("cookieBegin", { file });
          return {
            url: "", method: "auto",
            instructions: "Cookie 已导入专用浏览器，正在验证账号。若网页要求登录或验证，请在该窗口处理；确认账号和聊天输入框后才保存关联。" + remoteInstructions,
            async callback() {
              try {
                const status = await bridge.call<{ authenticated: boolean; accountId?: string }>("loginWait", { profileId });
                if (!status.authenticated) return { type: "failed", error: "Cookie 尚未恢复有效账号会话" };
                return { type: "success", key: `browser:${profileId}`, metadata: { profileId, email: status.accountId, mode: "cookie" } };
              } catch (e) { return { type: "failed", error: publicError(e).message }; }
            },
          };
        },
      }, {
        type: "oauth", label: "继续已有浏览器登录",
        prompts: [{
          type: "text", key: "profileId", message: "之前登录提示中的专用 profile UUID",
          validate(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value?.trim()) ? undefined : "请输入有效的专用 profile UUID"; },
        }],
        async authorize(inputs: Record<string, string> = {}) {
          const { profileId } = await bridge.call<{ profileId: string }>("loginBegin", { profileId: inputs.profileId?.trim() ?? "" });
          return {
            url: "", method: "auto",
            instructions: `正在继续同一个专用浏览器。请完成网页登录或验证；不会新建账号目录。专用 profile: ${profileId}${remoteInstructions}`,
            async callback() {
              try {
                const status = await bridge.call<{ authenticated: boolean; accountId?: string }>("loginWait", { profileId });
                if (!status.authenticated) return { type: "failed", error: "ChatGPT 登录尚未完成" };
                return { type: "success", key: `browser:${profileId}`, metadata: { profileId, email: status.accountId } };
              } catch (e) { return { type: "failed", error: publicError(e).message }; }
            },
          };
        },
      }],
      async loader(getAuth: () => Promise<Auth>) {
        // The tool hook runs outside this closure, so it reads the sign-in Magpie handed here.
        cachedGetAuth = getAuth;
        return {
          baseURL: BASE_URL, apiKey: "managed-browser-session",
          async fetch(url: string | URL | Request, init: RequestInit = {}): Promise<Response> {
            let source: AsyncIterableIterator<BrowserEvent> | undefined;
            try {
              checkAbort(init.signal ?? undefined);
              const target = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
              if (options.debugFile) {
                await appendFile(options.debugFile, JSON.stringify({
                  at: new Date().toISOString(), pathname: target.pathname, method: init.method ?? "POST",
                  body: typeof init.body === "string" ? init.body.slice(0, 4_000) : `(non-string body: ${typeof init.body})`,
                }) + "\n", { mode: 0o600 }).catch(() => {});
              }
              if ((init.method ?? "POST").toUpperCase() !== "POST") throw new WebError("This provider only accepts POST", 400, "unsupported_method");
              const profileId = profileOf(await getAuth());
              if (target.pathname === "/v1/images/generations") return await imagesResponse(bridge, profileId, init.body, options, init.signal ?? undefined);
              if (target.pathname === "/v1/chat/completions" && requestedModel(init.body) === IMAGE_MODEL) return await imageCompletion(bridge, profileId, init.body, options, init.signal ?? undefined);
              if (target.pathname === "/v1/images/edits") throw new WebError("Reference-image editing is not implemented yet; this prototype only does text-to-image", 400, "images_edits_unsupported");
              if (target.pathname !== "/v1/chat/completions") throw new WebError("This provider serves Chat Completions and Images; Magpie handles client protocol conversion", 400, "unsupported_endpoint");
              const completion = prepare(init.body, options);
              source = await bridge.open(profileId, completion, init.signal ?? undefined);
              return await completionResponse(source, completion, init.signal ?? undefined);
            } catch (e) {
              await source?.return?.();
              if (init.signal?.aborted) throw init.signal.reason ?? e;
              const error = publicError(e);
              const headers: Record<string, string> = { "cache-control": "no-store" };
              if (error.status === 401) headers["x-magpie-sign-in"] = "expired";
              if (error.status === 429) headers["retry-after"] = "5";
              return Response.json(errorBody(error), { status: error.status, headers });
            }
          },
        };
      },
      async usage(getAuth: () => Promise<Auth>) {
        try {
          const status = await bridge.call<{ authenticated: boolean; anonymous?: boolean; accountId?: string; modelLabel?: string }>("status", { profileId: profileOf(await getAuth()) });
          return { plan: status.anonymous ? "ChatGPT Web 匿名会话" : "ChatGPT Web 浏览器会话", user: status.accountId, message: status.modelLabel ? `网页当前模型：${status.modelLabel}` : "网页会话可用；额度尚未查询" };
        } catch (e) {
          const error = publicError(e);
          return { error: error.message, signIn: error.status === 401 ? "expired" : "kept" };
        }
      },
    },
    provider: { id: PROVIDER, async models() { return modelList(options); } },
    // An agent tool, so a caller that has no image API client can still ask for a picture. It is
    // the same webpage session as the provider: one browser profile, one serialized queue.
    tool: {
      chatgpt_web_generate_image: tool({
        description: "Draw a picture with the signed-in ChatGPT webpage image tool (the account's own web quota; not the OpenAI Images API and not Codex). Returns the local file path of every generated image.",
        args: {
          prompt: tool.schema.string().describe("What the picture should show, in any language"),
          size: tool.schema.string().optional().describe("Aspect ratio or pixel size, e.g. 1:1, 16:9, 1024x1024. A prompt hint: the answer reports the size actually delivered."),
          quality: tool.schema.enum(["auto", "low", "medium", "high"]).optional().describe("A wording hint for the webpage image tool"),
          n: tool.schema.number().int().min(1).max(4).optional().describe("How many pictures to ask for (default 1)"),
          output_dir: tool.schema.string().optional().describe("Absolute directory for the files; defaults to the plugin's imageDir"),
          filename: tool.schema.string().optional().describe("Base file name without extension"),
          image: tool.schema.string().optional().describe("A reference picture: absolute path on the gateway host, or a data: URL. The webpage keeps the subject and changes only what the prompt asks."),
        },
        async execute(args, ctx) {
          const profileId = profileOf(await getAuthForTool());
          if (!bridge.generateImage) return JSON.stringify({ success: false, error: "this runtime cannot generate images" });
          const references = await materializeReferences(args.image ? [args.image] : []);
          try {
            const result = await bridge.generateImage(profileId, {
              prompt: args.prompt,
              outputDir: args.output_dir?.trim() || options.imageDir,
              n: args.n ?? 1,
              ...(args.size ? { size: args.size } : {}),
              ...(args.quality && args.quality !== "auto" ? { quality: args.quality } : {}),
              ...(args.filename ? { filename: args.filename } : {}),
              ...(references.files.length ? { references: references.files } : {}),
            }, ctx.abort);
            return JSON.stringify({
              success: true,
              images: result.images.map(image => ({ path: image.path, width: image.width, height: image.height, mime_type: image.mimeType, bytes: image.bytes, sha256: image.sha256 })),
              webpage_model: result.modelLabel,
              elapsed_ms: result.elapsedMs,
              warnings: result.warnings,
            });
          } catch (e) {
            return JSON.stringify({ success: false, error: publicError(e).message, code: publicError(e).code });
          } finally { await references.cleanup(); }
        },
      }),
    },
  };
}
