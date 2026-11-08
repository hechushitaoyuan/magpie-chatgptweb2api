export declare const PROVIDER = "chatgpt-web";
export declare const BASE_URL = "https://chatgpt-web.invalid/v1";
export declare const SITE_URL = "https://chatgpt.com/";
export interface ModelOption {
    id: string;
    label: string;
    pickerLabel?: string;
    backendSlug?: string;
}
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
}
export declare function defaultProfilesDir(): string;
export declare function defaultImagesDir(): string;
export declare function parseOptions(input?: unknown): Options;
