import { type BrowserEvent, type Completion } from "./protocol.js";
import { type ImageRequest, type ImageResult } from "./image.js";
/** The model id the gateway and agents use for the webpage's picture ability. */
export declare const IMAGE_MODEL = "web-image";
export interface Auth {
    type: string;
    key?: string;
    metadata?: Record<string, unknown>;
}
export interface Runtime {
    call<T>(method: "loginBegin" | "cookieBegin" | "loginWait" | "guestBegin" | "guestWait" | "status", params: unknown, signal?: AbortSignal): Promise<T>;
    open(profileId: string, completion: Completion, signal?: AbortSignal): Promise<AsyncIterableIterator<BrowserEvent>>;
    close(): Promise<void>;
    generateImage?(profileId: string, request: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
    imageSession?(signal?: AbortSignal): Promise<unknown>;
}
export declare function createPluginHooks(input?: unknown, runtime?: Runtime): {
    config: (cfg: {
        provider?: Record<string, unknown>;
    }) => Promise<void>;
    auth: {
        provider: string;
        maxConcurrency: number;
        methods: ({
            type: string;
            label: string;
            authorize(): Promise<{
                url: string;
                method: string;
                instructions: string;
                callback(): Promise<{
                    type: string;
                    error: string;
                    key?: undefined;
                    metadata?: undefined;
                } | {
                    type: string;
                    key: string;
                    metadata: {
                        profileId: string;
                        email: string | undefined;
                    };
                    error?: undefined;
                }>;
            }>;
            prompts?: undefined;
        } | {
            type: string;
            label: string;
            prompts: {
                type: string;
                key: string;
                message: string;
                placeholder: string;
                validate(value: string): string | undefined;
            }[];
            authorize(inputs?: Record<string, string>): Promise<{
                url: string;
                method: string;
                instructions: string;
                callback(): Promise<{
                    type: string;
                    error: string;
                    key?: undefined;
                    metadata?: undefined;
                } | {
                    type: string;
                    key: string;
                    metadata: {
                        profileId: string;
                        email: string | undefined;
                        mode: string;
                    };
                    error?: undefined;
                }>;
            }>;
        } | {
            type: string;
            label: string;
            prompts: {
                type: string;
                key: string;
                message: string;
                validate(value: string): "请输入有效的专用 profile UUID" | undefined;
            }[];
            authorize(inputs?: Record<string, string>): Promise<{
                url: string;
                method: string;
                instructions: string;
                callback(): Promise<{
                    type: string;
                    error: string;
                    key?: undefined;
                    metadata?: undefined;
                } | {
                    type: string;
                    key: string;
                    metadata: {
                        profileId: string;
                        email: string | undefined;
                    };
                    error?: undefined;
                }>;
            }>;
        })[];
        loader(getAuth: () => Promise<Auth>): Promise<{
            baseURL: string;
            apiKey: string;
            fetch(url: string | URL | Request, init?: RequestInit): Promise<Response>;
        }>;
        usage(getAuth: () => Promise<Auth>): Promise<{
            plan: string;
            user: string | undefined;
            message: string;
            error?: undefined;
            signIn?: undefined;
        } | {
            error: string;
            signIn: string;
            plan?: undefined;
            user?: undefined;
            message?: undefined;
        }>;
    };
    provider: {
        id: string;
        models(): Promise<Record<string, unknown>>;
    };
    tool: {
        chatgpt_web_generate_image: {
            description: string;
            args: {
                prompt: import("zod").ZodString;
                size: import("zod").ZodOptional<import("zod").ZodString>;
                quality: import("zod").ZodOptional<import("zod").ZodEnum<{
                    auto: "auto";
                    low: "low";
                    medium: "medium";
                    high: "high";
                }>>;
                n: import("zod").ZodOptional<import("zod").ZodNumber>;
                output_dir: import("zod").ZodOptional<import("zod").ZodString>;
                filename: import("zod").ZodOptional<import("zod").ZodString>;
                image: import("zod").ZodOptional<import("zod").ZodString>;
            };
            execute(args: {
                prompt: string;
                size?: string | undefined;
                quality?: "auto" | "low" | "medium" | "high" | undefined;
                n?: number | undefined;
                output_dir?: string | undefined;
                filename?: string | undefined;
                image?: string | undefined;
            }, context: import("@opencode-ai/plugin").ToolContext): Promise<import("@opencode-ai/plugin").ToolResult>;
        };
    };
};
