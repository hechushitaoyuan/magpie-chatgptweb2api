import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { WebError } from "./errors.js";
export const DEFAULT_IMAGE_SUFFIX = "直接生成图片：请调用你的图片生成能力真正产出一张图片，不要只给文字描述、方案或提示词。";
const ASPECTS = {
    "1:1": { ratio: "1:1", words: "正方形" },
    "4:3": { ratio: "4:3", words: "横向 4:3" },
    "3:4": { ratio: "3:4", words: "竖向 3:4" },
    "16:9": { ratio: "16:9", words: "宽屏 16:9" },
    "9:16": { ratio: "9:16", words: "竖屏 9:16" },
    "3:2": { ratio: "3:2", words: "横向 3:2" },
    "2:3": { ratio: "2:3", words: "竖向 2:3" },
};
/**
 * Turns the caller's size into wording for the webpage. The ChatGPT web composer has no
 * aspect-ratio control that survives DOM changes, so this is a prompt hint: the answer
 * reports the size actually delivered rather than pretending the request was enforced.
 */
export function sizeInstruction(size) {
    const value = size?.trim();
    if (!value)
        return { text: "" };
    const named = {
        square: "1:1", "1x1": "1:1", landscape: "16:9", wide: "16:9", portrait: "9:16", tall: "9:16",
    };
    const lower = value.toLowerCase();
    if (named[lower])
        return { text: aspectText(named[lower]), ratio: named[lower] };
    const ratio = value.match(/^(\d{1,2}):(\d{1,2})$/);
    if (ratio && ASPECTS[`${ratio[1]}:${ratio[2]}`])
        return { text: aspectText(`${ratio[1]}:${ratio[2]}`), ratio: `${ratio[1]}:${ratio[2]}` };
    const pixels = value.match(/^(\d{2,4})\s*[x×]\s*(\d{2,4})$/i);
    if (pixels) {
        const w = Number(pixels[1]), h = Number(pixels[2]);
        if (w < 64 || h < 64 || w > 8192 || h > 8192)
            throw new WebError("size must be within 64–8192 pixels", 400, "invalid_size");
        const gcd = (a, b) => (b ? gcd(b, a % b) : a);
        return { text: `画面比例约 ${w}:${h}（接近 ${w / gcd(w, h)}:${h / gcd(w, h)}），像素约 ${w}×${h}`, ratio: `${w / gcd(w, h)}:${h / gcd(w, h)}` };
    }
    if (ASPECTS[lower])
        return { text: aspectText(lower), ratio: lower };
    throw new WebError("size must be a ratio like 16:9, a pixel size like 1024x1024, or square/landscape/portrait", 400, "invalid_size");
}
function aspectText(ratio) {
    const a = ASPECTS[ratio];
    return `画面比例 ${a.words}（${a.ratio}）`;
}
/** The single string submitted to the webpage composer. */
export function imagePrompt(request) {
    const prompt = request.prompt?.trim();
    if (!prompt)
        throw new WebError("prompt must be a nonempty string", 400, "missing_prompt");
    const { text, ratio } = sizeInstruction(request.size);
    const parts = [prompt];
    const hints = [];
    if (text && request.sizeHint !== false)
        hints.push(text + "。");
    const quality = request.quality?.trim();
    if (quality && quality !== "auto")
        hints.push(`画质要求：${quality}。`);
    const n = request.n ?? 1;
    if (n > 1)
        hints.push(`请一次生成 ${n} 张不同的图片。`);
    hints.push(request.promptSuffix?.trim() || DEFAULT_IMAGE_SUFFIX);
    parts.push(hints.join(""));
    return { prompt: parts.join("\n\n"), ratio };
}
const EXTENSIONS = {
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
};
export function extensionFor(mime, url = "") {
    const clean = mime.split(";")[0].trim().toLowerCase();
    if (EXTENSIONS[clean])
        return EXTENSIONS[clean];
    const fromUrl = url.match(/\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i);
    if (fromUrl)
        return fromUrl[1].toLowerCase().replace("jpeg", "jpg");
    return "png";
}
/** Reads intrinsic dimensions from the image header; undefined when the format isn't recognised. */
export function imageSize(buffer) {
    const b = buffer;
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
        if (b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
            return { width: view.getUint32(16), height: view.getUint32(20), mimeType: "image/png" };
        }
    }
    if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
        return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), mimeType: "image/gif" };
    }
    if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (kind === "VP8X")
            return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), mimeType: "image/webp" };
        if (kind === "VP8 ")
            return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, mimeType: "image/webp" };
        if (kind === "VP8L" && b.length > 25) {
            const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, mimeType: "image/webp" };
        }
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < b.length) {
            if (b[offset] !== 0xff) {
                offset++;
                continue;
            }
            const marker = b[offset + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                offset += 2;
                continue;
            }
            const length = (b[offset + 2] << 8) | b[offset + 3];
            if (length < 2)
                return undefined;
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { height: (b[offset + 5] << 8) | b[offset + 6], width: (b[offset + 7] << 8) | b[offset + 8], mimeType: "image/jpeg" };
            }
            offset += 2 + length;
        }
    }
    return undefined;
}
export function sniffMime(buffer) {
    return imageSize(buffer)?.mimeType;
}
async function exists(file) {
    try {
        await access(file);
        return true;
    }
    catch {
        return false;
    }
}
/** Never overwrites: an existing name gets -1, -2 … appended. */
async function freePath(directory, base, extension) {
    for (let i = 0; i < 1000; i++) {
        const candidate = join(directory, i === 0 ? `${base}.${extension}` : `${base}-${i}.${extension}`);
        if (!(await exists(candidate)))
            return candidate;
    }
    throw new WebError("Unable to find a free file name in the output directory", 500, "output_name_exhausted");
}
/**
 * A 256×256 PNG drawn here, used only by the `imageSelfTest` diagnostic: it answers the question
 * "does the gateway route an image request to this plugin and parse its answer?" without a
 * ChatGPT sign-in and without spending any quota. Never returned unless the option is on.
 */
export const SELF_TEST_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAD/0lEQVR42u3TQQ0AIRRDQeQgAmErETlIQMSGXjoJAib0vzG//fSdvZ4+fv4/bxiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAA+IXgAPiF4AD4heAA+IXgAPiDwXgg/ib/QLgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AXggPgF4ID4BeCA+AXggPgF4ID4UwH4IP5mvwD4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgE4IH4BOCB+ATggfgE4IH4BOCD+VAA+iL/ZLwB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAOiF8ADohfAA6IXwAOiF8ADog/FYAP4m/2C4BfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AD4heAA+IXgAPiF4AD4heAA+JPBeCD+Jv9AuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BWAAfgEYgF8ABuAXgAH4BeCA+AXggPgF4ID4BeCA+AXggPhTAfgg/ma/APgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ARiAXwAG4BeAAfgFYAB+ATggfgE4IH4BOCB+ATggfgE4IP5UAD6Iv9kvAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAAbgF4AB+AVgAH4BGIBfAA6IXwAOiF8ADohfAA6IXwAOiD/kv9J6GTPrVf+rAAAAAElFTkSuQmCC", "base64");
export function selfTestPayload(url = "selftest://magpie-chatgptweb2api") {
    return { bytes: SELF_TEST_PNG, mimeType: "image/png", url, via: "network" };
}
export async function saveImages(directory, payloads, baseName) {
    if (!directory)
        throw new WebError("An output directory is required", 400, "missing_output_dir");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const base = (baseName?.trim() || `chatgpt-web-${stamp}`).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || `chatgpt-web-${stamp}`;
    const saved = [];
    for (const payload of payloads) {
        const mime = payload.mimeType.split(";")[0].trim().toLowerCase() || sniffMime(payload.bytes) || "image/png";
        const path = await freePath(directory, base, extensionFor(mime, payload.url));
        const size = imageSize(payload.bytes);
        await writeFile(path, payload.bytes, { mode: 0o600, flag: "wx" });
        saved.push({
            path,
            filename: path.slice(path.lastIndexOf("/") + 1),
            mimeType: size?.mimeType ?? mime,
            bytes: payload.bytes.byteLength,
            ...(size ? { width: size.width, height: size.height } : {}),
            sha256: createHash("sha256").update(payload.bytes).digest("hex"),
            sourceUrl: payload.url.length > 300 ? payload.url.slice(0, 300) + "…" : payload.url,
            via: payload.via,
        });
    }
    return saved;
}
