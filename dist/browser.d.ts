import { type Options } from "./options.js";
import { type BrowserEvent, type Completion } from "./protocol.js";
import { type ImageRequest, type ImageResult } from "./image.js";
interface AuthStatus {
    authenticated: boolean;
    anonymous?: boolean;
    ready?: boolean;
    identity?: string;
    accountId?: string;
}
export declare class BrowserRuntime {
    readonly options: Options;
    private entries;
    private busy;
    private leases;
    private closed;
    private openingCount;
    private origin;
    constructor(options: Options, site?: string);
    private directory;
    private marker;
    private acquire;
    private release;
    private context;
    private auth;
    private requireAuth;
    private checkVerification;
    private waitForComposer;
    private begin;
    beginLogin(signal?: AbortSignal, profileId?: string): Promise<{
        profileId: string;
    }>;
    beginGuest(signal?: AbortSignal): Promise<{
        profileId: string;
    }>;
    beginCookieLogin(file: unknown, signal?: AbortSignal): Promise<{
        profileId: string;
    }>;
    waitLogin(id: string, signal?: AbortSignal): Promise<AuthStatus>;
    waitGuest(id: string, signal?: AbortSignal): Promise<AuthStatus>;
    status(id: string, signal?: AbortSignal): Promise<AuthStatus & {
        modelLabel?: string;
        browserMode?: string;
        windowKeptOpen?: boolean;
    }>;
    private selectModel;
    private snapshot;
    private readSnapshot;
    private checkAlerts;
    complete(id: string, completion: Completion, signal?: AbortSignal): AsyncGenerator<BrowserEvent>;
    /**
     * Answers with a locally drawn picture, so the gateway's image routing and response parsing can
     * be checked without signing in and without spending anyone's quota. Reached only while the
     * `imageSelfTest` option is on, and every result says so.
     */
    private selfTestImage;
    /**
     * Reads every assistant turn the page currently renders, with the images inside it. The
     * bytes are only carried when `extract` is set, so the polling path stays small even while
     * a data: URL is on screen.
     */
    private readImages;
    /** The bytes of one candidate, read through the browser context when the page's own fetch is refused. */
    private fetchImage;
    /**
     * Uploads the caller's reference pictures into the composer before the prompt is sent. The
     * webpage keeps hidden `input[type=file]` elements mounted for photo/video attachments, so the
     * upload goes through the same path a person uses; no request is made to any API endpoint.
     */
    /** Removes leftover attachment chips and text so a failed attempt cannot poison the next one. */
    private clearComposer;
    /** True while the composer shows a failed attachment ("Upload failed"). */
    private uploadFailed;
    private attachReferences;
    private static readonly IMAGE_REFUSAL;
    /**
     * Text-to-image through the logged-in ChatGPT web image tool.
     *
     * This is the webpage route only: the prompt goes into the composer, the picture is read back
     * out of the rendered assistant turn. No OpenAI API, Images API or Codex endpoint is used, and
     * no browser session material leaves the dedicated profile.
     */
    generateImage(id: string, request: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
    /**
     * Diagnostic read-back: saves the newest picture the open conversation already shows, without
     * sending anything. It exists so the extraction step can be checked against a real page — the
     * difference between "the webpage drew it" and "the plugin returned the caller's own upload".
     */
    latestImage(id: string, request: {
        outputDir: string;
        filename?: string;
    }, signal?: AbortSignal): Promise<ImageResult>;
    close(): Promise<void>;
}
export {};
