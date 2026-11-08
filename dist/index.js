import { createPluginHooks } from "./plugin.js";
/**
 * Magpie hands a plugin the whole Options object from its Plugins page, so a plugin that serves
 * one provider still receives `{ "<provider>": { … } }`. Unwrap our own key and refuse a
 * neighbouring plugin's options rather than mistaking them for ours.
 */
function ownOptions(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return input ?? {};
    const bag = input;
    if ("chatgpt-web" in bag && bag["chatgpt-web"] && typeof bag["chatgpt-web"] === "object")
        return bag["chatgpt-web"];
    return bag;
}
// Magpie treats every named exported function as a potential plugin. Expose
// only this v1 entry object; implementation helpers live in separate modules.
export default {
    id: "magpie-chatgptweb2api",
    async server(_input, options = {}) { return createPluginHooks(ownOptions(options)); },
};
