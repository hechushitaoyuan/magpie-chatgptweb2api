import { chromium, type Browser, type BrowserContext } from "playwright";
import { spawn } from "node:child_process";
import { access, readFile, lstat, open, readlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { type Options } from "./options.js";
import { WebError, delay } from "./errors.js";
import { managedBrowserExecutable } from "./browser-install.js";

async function executable(options: Options): Promise<string> {
  if (options.executablePath) return options.executablePath;
  if (!options.channel) return await managedBrowserExecutable();
  const edge = options.channel === "msedge";
  const candidates = process.platform === "darwin" ? [
    `/Applications/${edge ? "Microsoft Edge" : "Google Chrome"}.app/Contents/MacOS/${edge ? "Microsoft Edge" : "Google Chrome"}`,
    join(homedir(), `Applications/${edge ? "Microsoft Edge" : "Google Chrome"}.app/Contents/MacOS/${edge ? "Microsoft Edge" : "Google Chrome"}`),
  ] : process.platform === "win32" ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean).map(base => join(base!, edge ? "Microsoft/Edge/Application/msedge.exe" : "Google/Chrome/Application/chrome.exe")) : edge ? ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge"] : ["/opt/google/chrome/chrome", "/usr/bin/google-chrome"];
  for (const file of candidates) { try { await access(file); return file; } catch {} }
  throw new WebError("Configured browser was not found; configure executablePath or install it", 503, "browser_missing");
}

async function endpoint(directory: string): Promise<string | undefined> {
  try {
    const file = join(directory, "DevToolsActivePort");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1024) return undefined;
    const [port, path] = (await readFile(file, "utf8")).trim().split(/\r?\n/);
    if (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !path || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)) return undefined;
    // Only a browser-local loopback endpoint is read, never an arbitrary URL.
    const url = `http://127.0.0.1:${port}/json/version`;
    const response = await fetch(url, { signal: AbortSignal.timeout(800), redirect: "error" });
    if (!response.ok) return undefined;
    const info = await response.json() as { webSocketDebuggerUrl?: string };
    const ws = `ws://127.0.0.1:${port}${path}`;
    return info.webSocketDebuggerUrl === ws ? ws : undefined;
  } catch { return undefined; }
}

/**
 * True when the profile's Chrome lock belongs to a process that no longer exists.
 *
 * Chrome leaves `SingletonLock` (a `host-<pid>` symlink) and `DevToolsActivePort` behind when it
 * is killed without a clean shutdown. The plugin then refuses to launch ("this profile is open
 * without a plugin connection"), which surfaces to callers as a 409 even though nothing is
 * running. Only a lock whose owner is provably gone is cleared — a live browser is never touched.
 */
export async function lockOwnerGone(directory: string): Promise<boolean> {
  try {
    const target = await readlink(join(directory, "SingletonLock"));
    const pid = Number(target.slice(target.lastIndexOf("-") + 1));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch { return false; }
}

export async function clearStaleBrowserState(directory: string): Promise<void> {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"]) {
    await unlink(join(directory, name)).catch(() => {});
  }
}

export async function connectKeptBrowser(directory: string, options: Options, site: string): Promise<{ browser: Browser; context: BrowserContext }> {
  let ws = await endpoint(directory);
  if (!ws) {
    // Avoid two workers launching the same profile. Failed acquisition never
    // closes an existing window; the user can close it when convenient.
    const lockPath = join(directory, "magpie-launch.lock");
    let lock;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { lock = await open(lockPath, "wx", 0o600); break; }
      catch {
        let stale = false;
        try {
          const stat = await lstat(lockPath);
          if (stat.isFile() && stat.size < 64) {
            const pid = Number(await readFile(lockPath, "utf8"));
            if (Number.isSafeInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); }
              catch (e) { stale = (e as NodeJS.ErrnoException).code === "ESRCH"; }
            }
          }
        } catch { /* An unknown lock must not be removed. */ }
        if (!stale || attempt !== 0) throw new WebError("Browser startup is in progress; retry shortly", 409, "browser_starting");
        await unlink(lockPath);
      }
    }
    if (!lock) throw new WebError("Browser startup is in progress; retry shortly", 409, "browser_starting");
    await lock.writeFile(String(process.pid));
    try {
      ws = await endpoint(directory);
      if (!ws) {
        try {
          await lstat(join(directory, "SingletonLock"));
          if (!await lockOwnerGone(directory)) {
            throw new WebError("This profile is open without a plugin connection. Keep using that window; close it yourself before reopening with keep-open mode", 409, "browser_connection_unavailable");
          }
          // The owner is gone: Chrome was killed without cleaning up, so the lock is debris.
          await clearStaleBrowserState(directory);
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (process.platform === "linux" && !options.headless && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
          throw new WebError("Visible browser login needs a desktop display; run on a desktop or configure Xvfb/noVNC for remote login", 503, "browser_display_missing");
        }
        // Chrome launched for CDP still answers `navigator.webdriver === true` and carries
        // --enable-automation, which Cloudflare's check refuses to clear: the browser then sits on
        // "Just a moment…" forever and every page load fails. These two flags are what make the
        // dedicated browser a browser ChatGPT will actually serve.
        const args = [
          `--user-data-dir=${directory}`,
          "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
          "--no-first-run", "--no-default-browser-check",
          "--disable-blink-features=AutomationControlled",
        ];
        if (options.headless) args.push("--headless=new");
        if (options.proxy) args.push(`--proxy-server=${options.proxy}`);
        args.push(site);
        const child = spawn(await executable(options), args, { detached: true, stdio: "ignore" });
        let exited = false;
        child.once("exit", () => { exited = true; });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", error => reject(new WebError(
            (error as NodeJS.ErrnoException).code === "ENOENT" ? "Configured browser executable was not found; check executablePath or channel" : "Unable to execute the dedicated browser; check executable permissions",
            503, (error as NodeJS.ErrnoException).code === "ENOENT" ? "browser_missing" : "browser_launch_failed")));
        });
        child.unref();
        const deadline = Date.now() + 20_000;
        while (!ws && Date.now() < deadline && !exited) { ws = await endpoint(directory); if (!ws) await delay(200); }
        if (!ws) throw new WebError("Browser opened but its local connection is unavailable. Check the dedicated window; it has been left open", 503, "browser_connection_unavailable");
      }
    } finally { await lock.close(); await unlink(lockPath).catch(() => {}); }
  }
  let browser: Browser;
  try { browser = await chromium.connectOverCDP(ws, { timeout: 10_000, noDefaults: true }); }
  catch { throw new WebError("Unable to connect to the dedicated browser; the window has been left open", 503, "browser_connection_unavailable"); }
  const context = browser.contexts()[0];
  if (!context) { await browser.close(); throw new WebError("Browser has no default profile context", 503, "browser_connection_unavailable"); }
  // Pages opened from here on hide the automation tell as well as the launch flag does.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  }).catch(() => {});
  // For connectOverCDP, browser.close disconnects the transport. Never call
  // defaultContext.close: that could terminate the browser and login window.
  return { browser, context };
}
