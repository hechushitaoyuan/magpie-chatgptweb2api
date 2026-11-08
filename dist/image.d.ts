import { type ImageReference } from "./references.js";
/** A text-to-image request answered by the ChatGPT web image tool. */
export interface ImageRequest {
    prompt: string;
    /** "1024x1024", "1:1", "16:9", "4:3", "square", "landscape", "portrait". Best-effort only. */
    size?: string;
    /** "auto" | "low" | "medium" | "high" — a wording hint, never a hard upstream parameter. */
    quality?: string;
    /** Absolute directory the generated files are written to. */
    outputDir: string;
    /** Base file name without extension; defaults to a timestamp. */
    filename?: string;
    /** How many images to ask for (1–4). The webpage decides what it actually returns. */
    n?: number;
    /** Configured webpage model id; defaults to the first configured model. */
    model?: string;
    /** Replaces the built-in image-intent instruction appended to the prompt. */
    promptSuffix?: string;
    /** Overrides the plugin's imageTimeoutMs. */
    timeoutMs?: number;
    /**
     * Set false when the caller's prompt already states the size (Magpie appends
     * "Aspect ratio: …" itself). The ratio is still reported in the answer.
     */
    sizeHint?: boolean;
    /**
     * Pictures uploaded through the webpage composer before the prompt is sent, so the webpage
     * edits/keeps the subject instead of inventing one. Files must already exist on disk.
     */
    references?: ImageReference[];
}
export interface ImageFile {
    path: string;
    filename: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
    sha256: string;
    /** The URL the bytes were read from — blob: or an https chatgpt.com/oaiusercontent.com asset. */
    sourceUrl: string;
    /** How the bytes were obtained: in-page fetch, browser context request, or the network capture. */
    via: "page-fetch" | "context-request" | "network";
}
export interface ImageResult {
    success: true;
    profileId: string;
    model: string;
    modelLabel: string;
    prompt: string;
    requestedSize?: string;
    requestedCount: number;
    images: ImageFile[];
    /** Assistant text that accompanied the image, if any. */
    text: string;
    elapsedMs: number;
    warnings: string[];
}
export declare const DEFAULT_IMAGE_SUFFIX = "\u76F4\u63A5\u751F\u6210\u56FE\u7247\uFF1A\u8BF7\u8C03\u7528\u4F60\u7684\u56FE\u7247\u751F\u6210\u80FD\u529B\u771F\u6B63\u4EA7\u51FA\u4E00\u5F20\u56FE\u7247\uFF0C\u4E0D\u8981\u53EA\u7ED9\u6587\u5B57\u63CF\u8FF0\u3001\u65B9\u6848\u6216\u63D0\u793A\u8BCD\u3002";
/**
 * Turns the caller's size into wording for the webpage. The ChatGPT web composer has no
 * aspect-ratio control that survives DOM changes, so this is a prompt hint: the answer
 * reports the size actually delivered rather than pretending the request was enforced.
 */
export declare function sizeInstruction(size?: string): {
    text: string;
    ratio?: string;
};
/** The single string submitted to the webpage composer. */
export declare function imagePrompt(request: ImageRequest): {
    prompt: string;
    ratio?: string;
};
export declare function extensionFor(mime: string, url?: string): string;
/** Reads intrinsic dimensions from the image header; undefined when the format isn't recognised. */
export declare function imageSize(buffer: Uint8Array): {
    width: number;
    height: number;
    mimeType?: string;
} | undefined;
export declare function sniffMime(buffer: Uint8Array): string | undefined;
/**
 * A 256×256 PNG drawn here, used only by the `imageSelfTest` diagnostic: it answers the question
 * "does the gateway route an image request to this plugin and parse its answer?" without a
 * ChatGPT sign-in and without spending any quota. Never returned unless the option is on.
 */
export declare const SELF_TEST_PNG: Buffer<ArrayBuffer>;
export declare function selfTestPayload(url?: string): BytePayload;
export interface BytePayload {
    bytes: Uint8Array;
    mimeType: string;
    url: string;
    via: ImageFile["via"];
}
export declare function saveImages(directory: string, payloads: BytePayload[], baseName?: string): Promise<ImageFile[]>;
