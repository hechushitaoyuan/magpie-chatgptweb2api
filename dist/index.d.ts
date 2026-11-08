declare const _default: {
    id: string;
    server(_input: unknown, options?: unknown): Promise<{
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
            loader(getAuth: () => Promise<import("./plugin.js").Auth>): Promise<{
                baseURL: string;
                apiKey: string;
                fetch(url: string | URL | Request, init?: RequestInit): Promise<Response>;
            }>;
            usage(getAuth: () => Promise<import("./plugin.js").Auth>): Promise<{
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
    }>;
};
export default _default;
