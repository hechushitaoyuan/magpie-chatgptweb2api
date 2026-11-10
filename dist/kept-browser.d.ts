import { type Browser, type BrowserContext } from "playwright";
import { type Options } from "./options.js";
/**
 * True when the profile's Chrome lock belongs to a process that no longer exists.
 *
 * Chrome leaves `SingletonLock` (a `host-<pid>` symlink) and `DevToolsActivePort` behind when it
 * is killed without a clean shutdown. The plugin then refuses to launch ("this profile is open
 * without a plugin connection"), which surfaces to callers as a 409 even though nothing is
 * running. Only a lock whose owner is provably gone is cleared — a live browser is never touched.
 */
export declare function lockOwnerGone(directory: string): Promise<boolean>;
export declare function clearStaleBrowserState(directory: string): Promise<void>;
export declare function connectKeptBrowser(directory: string, options: Options, site: string): Promise<{
    browser: Browser;
    context: BrowserContext;
}>;
