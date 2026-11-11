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
/** The ChatGPT conversation image generation is bound to. Kept on disk so a restart reuses it. */
interface ImageSession {
    version: 1;
    id: string;
    title: string;
    url: string;
    resolvedAt: string;
    source: "explicit" | "url" | "title";
}
export declare class BrowserRuntime {
    readonly options: Options;
    private entries;
    /** The one hot tab that serves image generation, per profile. Never used by text or probes. */
    private imageTabs;
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
    private conversationUrl;
    private conversationIdOf;
    private readImageSession;
    private writeImageSession;
    /** Titles of this account's conversations, read inside the page with the page's own session. */
    private findConversationByTitle;
    /** A page showing the browser check instead of the chat is never used or sent into. */
    private isChallenged;
    private resolveByTitle;
    /**
     * Decides which conversation image generation belongs to. An explicit id or URL wins; then the
     * binding remembered on disk; only when neither exists is the title looked up once — through the
     * page's own session — and written down, so later requests never look it up again.
     *
     * A title lookup is the only path that needs a page. It reads an already-open tab when there is
     * one and never navigates it.
     */
    private resolveImageSession;
    private composerVisible;
    /** Waits for the bound conversation to be usable, naming a browser check as soon as it shows. */
    private waitForBoundChat;
    /** True when this tab is still the bound conversation and is not showing the browser check. */
    private usableImageTab;
    /**
     * The bound conversation's own hot tab. An already-open tab is adopted so a page that already
     * cleared the browser check is never reloaded; only when no tab holds it is one opened at the
     * conversation URL. Other tabs are never touched, and no new conversation is ever created.
     */
    private dedicatedImageTab;
    /**
     * Binds image generation now and writes it down. The value is a conversation URL, an id or a
     * title; with none, the configured title is resolved. Nothing is ever created — an unknown
     * conversation is an error.
     */
    bindImageSession(profileId: string, value: string | undefined, signal?: AbortSignal): Promise<ImageSession & {
        profileId: string;
    }>;
    /**
     * Walks the whole image route and stops before anything is typed: which conversation is bound,
     * whether its tab was adopted or opened, whether the account and the composer are usable, and
     * what the conversation already holds. It never sends and never creates a conversation, so it
     * costs no picture quota.
     */
    inspectImageRoute(profileId: string, signal?: AbortSignal): Promise<{
        bound: boolean;
        id?: string;
        title?: string;
        url?: string;
        source?: string;
        tab?: "adopted" | "opened";
        pageTitle?: string;
        authenticated?: boolean;
        accountId?: string;
        composer?: boolean;
        sendReady?: boolean;
        turns?: number;
        images?: number;
        modelLabel?: string;
    }>;
    /**
     * Clears only Cloudflare's own cookies for this site. Measured 2026-11-09: a profile whose
     * clearance cookies were issued to an earlier browser build loops on "Just a moment…" forever,
     * and dropping these five makes the very next load answer immediately. Sign-in cookies are not
     * touched, so the account stays signed in.
     */
    clearBrowserChallenge(profileId: string, signal?: AbortSignal): Promise<{
        cleared: string[];
    }>;
    /** What image generation is bound to, without opening a browser. */
    imageSessionStatus(): Promise<{
        bound: boolean;
        id?: string;
        title?: string;
        url?: string;
        source?: string;
        resolvedAt?: string;
        configured: {
            title: string;
            id?: string;
            url?: string;
            allowNewChat: boolean;
        };
    }>;
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
