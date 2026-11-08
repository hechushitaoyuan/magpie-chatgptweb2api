import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebError } from "./errors.js";
import { extensionFor, imageSize } from "./image.js";

/** A picture the caller wants the webpage to look at while it draws the answer. */
export interface ImageReference {
  /** Absolute path on the machine that runs the plugin. */
  path: string;
  mimeType?: string;
}

const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCES = 4;

/**
 * The reference images a request carries. OpenAI's Images API has no field for this, so the
 * plugin accepts the three shapes a caller can realistically send: `image`, `images` and
 * `reference_images`, each a data: URL, an absolute path, or a list of those.
 */
export function referenceValues(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const body = input as Record<string, unknown>;
  const raw = body.reference_images ?? body.images ?? body.image;
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map(value => value.trim());
}

/**
 * Copies every reference into a private temporary directory so the browser can be handed a file.
 * Data URLs are decoded here; a path is only accepted when it points at a real image, because an
 * HTTP caller must not be able to push an arbitrary readable file into a chat upload.
 */
export async function materializeReferences(values: string[]): Promise<{ files: ImageReference[]; cleanup: () => Promise<void> }> {
  if (values.length > MAX_REFERENCES) throw new WebError(`At most ${MAX_REFERENCES} reference images are supported`, 400, "too_many_references");
  if (!values.length) return { files: [], cleanup: async () => {} };
  const directory = join(tmpdir(), `magpie-chatgptweb2api-refs-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cleanup = async () => { await rm(directory, { recursive: true, force: true }).catch(() => {}); };
  const files: ImageReference[] = [];
  try {
    for (const [index, value] of values.entries()) {
      const inline = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
      if (inline) {
        const bytes = Buffer.from(inline[2]!, "base64");
        if (!bytes.length) throw new WebError("A reference image decoded to zero bytes", 400, "invalid_reference");
        if (bytes.length > MAX_BYTES) throw new WebError(`A reference image must be at most ${MAX_BYTES / 1024 / 1024} MiB`, 413, "reference_too_large");
        if (!imageSize(bytes)) throw new WebError("A reference data: URL did not decode to a PNG, JPEG, WebP or GIF image", 400, "invalid_reference");
        const path = join(directory, `reference-${index + 1}.${extensionFor(inline[1]!, "")}`);
        await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
        files.push({ path, mimeType: inline[1]! });
        continue;
      }
      const path = value.startsWith("file://") ? fileURLToPath(value) : value;
      if (!isAbsolute(path)) throw new WebError("A reference image must be a data: URL or an absolute path", 400, "invalid_reference");
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) throw new WebError(`The reference image does not exist: ${path}`, 400, "reference_not_found");
      if (info.size === 0) throw new WebError(`The reference image is empty: ${path}`, 400, "invalid_reference");
      if (info.size > MAX_BYTES) throw new WebError(`A reference image must be at most ${MAX_BYTES / 1024 / 1024} MiB`, 413, "reference_too_large");
      const head = (await readFile(path)).subarray(0, 64 * 1024);
      const sniffed = imageSize(head);
      if (!sniffed) throw new WebError(`The reference file is not a PNG, JPEG, WebP or GIF image: ${path}`, 400, "invalid_reference");
      files.push({ path, mimeType: sniffed.mimeType });
    }
    return { files, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Reference pictures carried as chat-completion `image_url` parts, which is how an agent sends them. */
export function referenceParts(body: unknown): string[] {
  if (typeof body !== "string") return [];
  let parsed: { messages?: unknown } = {};
  try { parsed = JSON.parse(body) as { messages?: unknown }; } catch { return []; }
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const found: string[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as { type?: string; image_url?: unknown }[]) {
      const url = typeof part?.image_url === "string" ? part.image_url : (part?.image_url as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && url.startsWith("data:image/")) found.push(url);
    }
  }
  return found;
}
