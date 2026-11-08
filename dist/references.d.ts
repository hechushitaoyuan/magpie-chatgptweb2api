/** A picture the caller wants the webpage to look at while it draws the answer. */
export interface ImageReference {
    /** Absolute path on the machine that runs the plugin. */
    path: string;
    mimeType?: string;
}
export declare const MAX_REFERENCES = 4;
/**
 * The reference images a request carries. OpenAI's Images API has no field for this, so the
 * plugin accepts the three shapes a caller can realistically send: `image`, `images` and
 * `reference_images`, each a data: URL, an absolute path, or a list of those.
 */
export declare function referenceValues(input: unknown): string[];
/**
 * Copies every reference into a private temporary directory so the browser can be handed a file.
 * Data URLs are decoded here; a path is only accepted when it points at a real image, because an
 * HTTP caller must not be able to push an arbitrary readable file into a chat upload.
 */
export declare function materializeReferences(values: string[]): Promise<{
    files: ImageReference[];
    cleanup: () => Promise<void>;
}>;
/** Reference pictures carried as chat-completion `image_url` parts, which is how an agent sends them. */
export declare function referenceParts(body: unknown): string[];
