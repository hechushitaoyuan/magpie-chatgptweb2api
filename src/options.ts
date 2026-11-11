import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { WebError } from "./errors.js";

export const PROVIDER = "chatgpt-web";
export const BASE_URL = "https://chatgpt-web.invalid/v1";
export const SITE_URL = "https://chatgpt.com/";
export interface ModelOption { id: string; label: string; pickerLabel?: string; backendSlug?: string }
export interface Options {
  profilesDir: string;
  executablePath?: string;
  channel?: "chrome" | "msedge";
  proxy?: string;
  headless: boolean;
  internalReader: boolean;
  internalSender: boolean;
  remoteLoginUrl?: string;
  browserMode: "keep-open" | "managed";
  timeoutMs: number;
  loginTimeoutMs: number;
  idleTimeoutMs: number;
  pollMs: number;
  settleMs: number;
  maxPromptChars: number;
  maxOutputChars: number;
  contextLimit: number;
  outputLimit: number;
  models: ModelOption[];
  /** Where generate_image writes its files when the caller names no directory. */
  imageDir: string;
  imageTimeoutMs: number;
  imagePromptSuffix?: string;
  imageFileName?: string;
  /** Diagnostic: answer image requests with a locally drawn picture, never the browser. */
  imageSelfTest: boolean;
  /** Diagnostic: append every provider request this plugin receives to this file. */
  debugFile?: string;
  /** Exact title of the ChatGPT conversation image generation is bound to. */
  imageConversationTitle: string;
  /** Stable conversation id; when set it wins over the title. */
  imageConversationId?: string;
  /** Full conversation URL; when set it wins over the id. */
  imageConversationUrl?: string;
  /** Off by default: an unbound image request fails instead of quietly opening a new chat. */
  imageAllowNewChat: boolean;
  /** Where the resolved binding is kept, so a restart reuses it. */
  imageSessionFile: string;
}

function integer(o: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = o[key] ?? fallback;
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) {
    throw new WebError(`${key} must be an integer from ${min} to ${max}`, 400, "invalid_options");
  }
  return v as number;
}

export function defaultProfilesDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "magpie-chatgptweb2api", "profiles");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || homedir(), "magpie-chatgptweb2api", "profiles");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "magpie-chatgptweb2api", "profiles");
}

export function defaultImagesDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "magpie-chatgptweb2api", "images");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || homedir(), "magpie-chatgptweb2api", "images");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "magpie-chatgptweb2api", "images");
}

/** Splits the one-line `imageConversation` shorthand into the three explicit fields. */
function conversationBinding(o: Record<string, unknown>): { imageConversationTitle: string; imageConversationId?: string; imageConversationUrl?: string } {
  const shorthand = typeof o.imageConversation === "string" ? o.imageConversation.trim() : "";
  const url = (o.imageConversationUrl as string | undefined)?.trim() || (/^https?:\/\//.test(shorthand) ? shorthand : undefined);
  const id = (o.imageConversationId as string | undefined)?.trim()
    || (shorthand && !url && /^[0-9a-fA-F-]{8,64}$/.test(shorthand) ? shorthand : undefined);
  const title = (o.imageConversationTitle as string | undefined)?.trim() || (shorthand && !url && !id ? shorthand : "");
  return { imageConversationTitle: title, ...(id ? { imageConversationId: id } : {}), ...(url ? { imageConversationUrl: url } : {}) };
}

export function parseOptions(input: unknown = {}): Options {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WebError("Plugin options must be an object", 400, "invalid_options");
  const o = input as Record<string, unknown>;
  const known = new Set(["internalReader", "browserMode", "profilesDir", "executablePath", "channel", "proxy", "headless", "timeoutMs", "loginTimeoutMs", "idleTimeoutMs", "pollMs", "settleMs", "maxPromptChars", "maxOutputChars", "contextLimit", "outputLimit", "models", "imageDir", "imageTimeoutMs", "imagePromptSuffix", "imageFileName", "imageSelfTest", "debugFile", "imageConversationTitle", "imageConversationId", "imageConversationUrl", "imageAllowNewChat", "imageSessionFile", "imageConversation"]);
  known.add("internalSender");
  known.add("remoteLoginUrl");
  for (const k of Object.keys(o)) if (!known.has(k)) throw new WebError(`Unknown plugin option: ${k}`, 400, "invalid_options");
  for (const k of ["profilesDir", "executablePath", "proxy", "imageDir", "debugFile", "imageConversationId", "imageConversationUrl"]) if (o[k] !== undefined && (typeof o[k] !== "string" || !o[k].trim())) throw new WebError(`${k} must be a nonempty string`, 400, "invalid_options");
  if (o.browserMode !== undefined && !["keep-open", "managed"].includes(o.browserMode as string)) throw new WebError("browserMode must be keep-open or managed", 400, "invalid_options");
  if (o.headless !== undefined && typeof o.headless !== "boolean") throw new WebError("headless must be a boolean", 400, "invalid_options");
  if (o.internalReader !== undefined && typeof o.internalReader !== "boolean") throw new WebError("internalReader must be a boolean", 400, "invalid_options");
  if (o.internalSender !== undefined && typeof o.internalSender !== "boolean") throw new WebError("internalSender must be a boolean", 400, "invalid_options");
  if (o.remoteLoginUrl !== undefined) {
    let remote: URL;
    try { remote = new URL(String(o.remoteLoginUrl)); } catch { throw new WebError("remoteLoginUrl must be a protected HTTPS URL", 400, "invalid_options"); }
    if (typeof o.remoteLoginUrl !== "string" || remote.protocol !== "https:" || !remote.href.startsWith(`https://${remote.host}/`) || remote.search || remote.hash) throw new WebError("remoteLoginUrl must use HTTPS without credentials, query or fragment", 400, "invalid_options");
  }
  if (o.channel !== undefined && o.channel !== "chrome" && o.channel !== "msedge") throw new WebError("channel must be chrome or msedge", 400, "invalid_options");
  if (o.channel && o.executablePath) throw new WebError("Choose channel or executablePath", 400, "invalid_options");
  if (o.imagePromptSuffix !== undefined && (typeof o.imagePromptSuffix !== "string" || o.imagePromptSuffix.length > 2_000)) throw new WebError("imagePromptSuffix must be a string of at most 2000 characters", 400, "invalid_options");
  if (o.imageFileName !== undefined && (typeof o.imageFileName !== "string" || !o.imageFileName.trim() || o.imageFileName.length > 120)) throw new WebError("imageFileName must be a nonempty string of at most 120 characters", 400, "invalid_options");
  if (o.imageSelfTest !== undefined && typeof o.imageSelfTest !== "boolean") throw new WebError("imageSelfTest must be a boolean", 400, "invalid_options");
  if (o.imageAllowNewChat !== undefined && typeof o.imageAllowNewChat !== "boolean") throw new WebError("imageAllowNewChat must be a boolean", 400, "invalid_options");
  if (o.imageConversationId !== undefined && (typeof o.imageConversationId !== "string" || !/^[0-9a-fA-F-]{8,64}$/.test(o.imageConversationId.trim()))) throw new WebError("imageConversationId must be a ChatGPT conversation id", 400, "invalid_options");
  if (o.imageConversationUrl !== undefined) {
    if (typeof o.imageConversationUrl !== "string") throw new WebError("imageConversationUrl must be a string", 400, "invalid_options");
    let u: URL;
    try { u = new URL(o.imageConversationUrl.trim()); } catch { throw new WebError("imageConversationUrl must be a chatgpt.com conversation URL", 400, "invalid_options"); }
    if (u.protocol !== "https:" || u.hostname !== "chatgpt.com" || !/^\/c\/[0-9a-fA-F-]{8,64}$/.test(u.pathname)) throw new WebError("imageConversationUrl must be a chatgpt.com conversation URL like https://chatgpt.com/c/<id>", 400, "invalid_options");
  }
  if (o.proxy) {
    let u: URL;
    try { u = new URL(o.proxy as string); } catch { throw new WebError("proxy must be a valid URL", 400, "invalid_options"); }
    if (!["http:", "https:", "socks5:"].includes(u.protocol) || u.username || u.password || (u.pathname !== "/" && u.pathname) || u.search || u.hash) throw new WebError("proxy must be an HTTP, HTTPS or SOCKS5 URL without credentials or a path", 400, "invalid_options");
  }
  const models = o.models ?? [{ id: "web-current", label: "ChatGPT Web · 当前网页模型" }];
  if (!Array.isArray(models) || models.length < 1 || models.length > 32) throw new WebError("models must contain 1–32 entries", 400, "invalid_options");
  const seen = new Set<string>();
  const validated = models.map(m => {
    if (!m || typeof m !== "object" || typeof m.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(m.id) || typeof m.label !== "string" || !m.label.trim() || m.label.length > 200 || (m.pickerLabel !== undefined && (typeof m.pickerLabel !== "string" || !m.pickerLabel.trim() || m.pickerLabel.length > 200))) throw new WebError("Each model needs id, label and optional exact pickerLabel", 400, "invalid_options");
    if (seen.has(m.id)) throw new WebError("Model ids must be unique", 400, "invalid_options");
    if (m.backendSlug !== undefined && (typeof m.backendSlug !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(m.backendSlug))) throw new WebError("backendSlug must be an explicit internal model identifier", 400, "invalid_options");
    seen.add(m.id);
    return { id: m.id, label: m.label, ...(m.pickerLabel ? { pickerLabel: m.pickerLabel } : {}), ...(m.backendSlug ? { backendSlug: m.backendSlug } : {}) };
  });
  return {
    profilesDir: resolve((o.profilesDir as string | undefined) ?? defaultProfilesDir()),
    executablePath: o.executablePath as string | undefined,
    channel: o.channel as Options["channel"],
    proxy: o.proxy as string | undefined,
    browserMode: (o.browserMode as Options["browserMode"] | undefined) ?? "keep-open",
    headless: (o.headless as boolean | undefined) ?? false,
    internalReader: (o.internalReader as boolean | undefined) ?? false,
    internalSender: (o.internalSender as boolean | undefined) ?? false,
    remoteLoginUrl: o.remoteLoginUrl as string | undefined,
    timeoutMs: integer(o, "timeoutMs", 180_000, 1_000, 1_800_000),
    loginTimeoutMs: integer(o, "loginTimeoutMs", 300_000, 1_000, 900_000),
    idleTimeoutMs: integer(o, "idleTimeoutMs", 60_000, 1_000, 600_000),
    pollMs: integer(o, "pollMs", 250, 50, 2_000),
    settleMs: integer(o, "settleMs", 1_000, 100, 10_000),
    maxPromptChars: integer(o, "maxPromptChars", 80_000, 100, 500_000),
    maxOutputChars: integer(o, "maxOutputChars", 500_000, 100, 1_000_000),
    contextLimit: integer(o, "contextLimit", 16_384, 1, 200_000),
    outputLimit: integer(o, "outputLimit", 4_096, 1, 100_000),
    models: validated,
    imageDir: resolve((o.imageDir as string | undefined) ?? defaultImagesDir()),
    imageTimeoutMs: integer(o, "imageTimeoutMs", 360_000, 5_000, 1_800_000),
    imagePromptSuffix: o.imagePromptSuffix as string | undefined,
    imageFileName: o.imageFileName as string | undefined,
    imageSelfTest: (o.imageSelfTest as boolean | undefined) ?? false,
    debugFile: o.debugFile as string | undefined,
    // `imageConversation` is the shorthand the Magpie Options field uses; it takes a title, an id
    // or a URL, whichever the operator pasted.
    ...conversationBinding(o),
    imageAllowNewChat: (o.imageAllowNewChat as boolean | undefined) ?? false,
    imageSessionFile: resolve((o.imageSessionFile as string | undefined) ?? join(resolve((o.profilesDir as string | undefined) ?? defaultProfilesDir()), "image-session.json")),
  };
}
