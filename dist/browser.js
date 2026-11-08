import { chromium } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { SITE_URL } from "./options.js";
import { WebError, checkAbort, delay } from "./errors.js";
import { MarkdownStream, toMarkdown } from "./markdown.js";
import { imagePrompt, saveImages, selfTestPayload, sniffMime } from "./image.js";
import { connectKeptBrowser } from "./kept-browser.js";
import { lockProfile } from "./profile-lock.js";
import { readCookieFile } from "./cookies.js";
import { readInternalReply } from "./internal-reader.js";
import { Submission } from "./submission.js";
import { sendInternal } from "./internal-sender.js";
import { managedBrowserExecutable } from "./browser-install.js";
const COMPOSER = '[data-testid="prompt-textarea"], #prompt-textarea, textarea[data-mobile-composer-prompt], textarea[data-id="root"], [contenteditable="true"][data-lexical-editor="true"], form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"][role="textbox"]';
const SEND = '[data-testid="send-button"], [data-testid="composer-submit-button"], button[data-composer-submit], form[data-chatgpt-composer] button[type="submit"], button[aria-label="Send prompt"], button[aria-label="Send"], button[aria-label="发送提示"]';
const STOP = '[data-testid="stop-button"], button[data-composer-submit]:has([data-composer-stop-icon]:not([hidden])), form[data-chatgpt-composer] button[aria-label="Stop"], button[aria-label="Stop generating"], button[aria-label="Stop"], button[aria-label="停止生成"]';
const PICKER = '[data-testid="model-switcher-dropdown-button"], [data-testid="model-picker-dropdown-button"], button[aria-label="Select ChatGPT model"]';
/** Hidden composer inputs the current web UI keeps mounted for photo/video attachments. */
const ATTACH = 'input[type="file"][aria-label="Attach photos"], input[type="file"][aria-label="Attach photos or videos"], input[type="file"][accept^="image/"][multiple]';
/** How long a second operation waits for the one holding this profile (bounded, never a retry loop). */
const BUSY_WAIT_MS = 90_000;
const PROFILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class BrowserRuntime {
    options;
    entries = new Map();
    busy = new Set();
    leases = new Map();
    closed = false;
    openingCount = 0;
    origin;
    constructor(options, site = SITE_URL) {
        this.options = options;
        const u = new URL(site);
        if (u.origin !== new URL(SITE_URL).origin && !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
            throw new WebError("Only ChatGPT and loopback test fixtures are supported", 400, "invalid_site");
        this.origin = u.origin;
    }
    directory(id) {
        if (!PROFILE_PATTERN.test(id))
            throw new WebError("Invalid browser profile; sign in again", 401, "invalid_profile");
        return join(this.options.profilesDir, id);
    }
    async marker(id) {
        const dir = this.directory(id);
        let m;
        try {
            if ((await lstat(dir)).isSymbolicLink())
                throw new Error("symlink");
            const file = join(dir, "magpie-profile.json");
            if ((await lstat(file)).isSymbolicLink())
                throw new Error("symlink");
            m = JSON.parse(await readFile(file, "utf8"));
        }
        catch {
            throw new WebError("This browser profile is unavailable; sign in again", 401, "profile_missing");
        }
        if (m.version !== 1 || m.profileId !== id || m.origin !== this.origin)
            throw new WebError("The browser profile belongs to another site or version", 401, "profile_mismatch");
        return m;
    }
    async acquire(id, signal) {
        checkAbort(signal);
        if (this.closed)
            throw new WebError("The browser runtime is closing", 503, "runtime_closed");
        // One profile, one browser: a second operation waits for the first instead of being turned
        // away. The wait is bounded (the gateway probes the same profile for sign-in state), so a
        // stuck operation still ends as a clear 429 rather than an endless retry.
        const waitUntil = Date.now() + BUSY_WAIT_MS;
        while (this.busy.has(id)) {
            if (Date.now() >= waitUntil)
                throw new WebError("This account already has a browser operation in progress", 429, "account_busy");
            await delay(this.options.pollMs, signal);
            checkAbort(signal);
        }
        this.busy.add(id);
        const entry = this.entries.get(id);
        if (entry?.timer)
            clearTimeout(entry.timer);
        let lease;
        try {
            await this.marker(id);
            lease = await lockProfile(this.directory(id));
            checkAbort(signal);
            if (this.closed)
                throw new WebError("The browser runtime is closing", 503, "runtime_closed");
            this.leases.set(id, lease);
            return signal ? AbortSignal.any([signal, lease.signal]) : lease.signal;
        }
        catch (e) {
            await lease?.release();
            this.busy.delete(id);
            throw e;
        }
    }
    async release(id) {
        const lease = this.leases.get(id);
        this.leases.delete(id);
        await lease?.release();
        this.busy.delete(id);
        const entry = this.entries.get(id);
        if (!entry || this.closed)
            return;
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            if (this.busy.has(id))
                return;
            this.entries.delete(id);
            void entry.disconnect().catch(() => { });
        }, this.options.idleTimeoutMs);
        entry.timer.unref();
    }
    async context(id, login = false) {
        const marker = await this.marker(id);
        if (this.closed)
            throw new WebError("The browser runtime is closing", 503, "runtime_closed");
        const old = this.entries.get(id);
        if (old)
            return old;
        if (this.entries.size + this.openingCount >= 4)
            throw new WebError("Four browser profiles are connected; wait for an idle connection to be released", 429, "browser_capacity");
        let context;
        let disconnect;
        this.openingCount++;
        try {
            if ((marker.browserMode ?? "managed") === "keep-open") {
                const kept = await connectKeptBrowser(this.directory(id), { ...this.options, headless: login && this.origin === new URL(SITE_URL).origin ? false : this.options.headless }, this.origin);
                context = kept.context;
                disconnect = () => kept.browser.close();
            }
            else {
                context = await chromium.launchPersistentContext(this.directory(id), {
                    executablePath: this.options.executablePath ?? (this.options.channel ? undefined : await managedBrowserExecutable()),
                    channel: this.options.channel,
                    headless: login && this.origin === new URL(SITE_URL).origin ? false : this.options.headless,
                    viewport: { width: 1280, height: 900 },
                    proxy: this.options.proxy ? { server: this.options.proxy } : undefined,
                    timeout: 30_000,
                });
                disconnect = () => context.close();
            }
        }
        catch (e) {
            if (e instanceof WebError)
                throw e;
            const message = String(e?.message ?? "");
            if (/Executable doesn't exist|executable.*does not exist|executablePath/i.test(message))
                throw new WebError("Browser not found; automatic installation failed. Configure channel or executablePath", 503, "browser_missing");
            if (/ProcessSingleton|SingletonLock|user data directory is already in use/i.test(message))
                throw new WebError("This browser profile is open in another process; close it and retry", 409, "profile_in_use");
            throw new WebError("Unable to start the dedicated browser; check browser installation and profile permissions", 503, "browser_launch_failed");
        }
        finally {
            this.openingCount--;
        }
        if (this.closed) {
            await disconnect();
            throw new WebError("The browser runtime is closing", 503, "runtime_closed");
        }
        context.setDefaultTimeout(5_000);
        context.setDefaultNavigationTimeout(30_000);
        const entry = { context, disconnect };
        this.entries.set(id, entry);
        context.on("close", () => { if (this.entries.get(id) === entry)
            this.entries.delete(id); if (entry.timer)
            clearTimeout(entry.timer); });
        return entry;
    }
    async auth(page) {
        const raw = await page.evaluate(async () => {
            const summarize = (session) => {
                const user = session?.user;
                const identity = typeof user?.id === "string" ? user.id : typeof user?.email === "string" ? user.email : "";
                // Only identity leaves the page; access tokens and cookies stay there.
                return { authenticated: Boolean(identity), identity, accountId: typeof user?.email === "string" ? user.email : identity };
            };
            try {
                const r = await fetch("/api/auth/session", { credentials: "same-origin", signal: AbortSignal.timeout(10_000) });
                // An explicit signed-out JSON session takes priority over page bootstrap.
                if (r.ok)
                    return summarize(await r.json());
            }
            catch { /* The current page can supply its own authenticated bootstrap. */ }
            try {
                const bootstrap = JSON.parse(document.querySelector('script#client-bootstrap[type="application/json"]')?.textContent ?? "null");
                const session = bootstrap?.session;
                // Account pages currently embed the server session here. Mere account
                // theme attributes or an anonymous input box are not authentication.
                if (typeof session?.accessToken === "string" && session.accessToken.length > 0)
                    return summarize(session);
            }
            catch { /* Malformed or absent bootstrap is not a valid account. */ }
            return summarize(undefined);
        });
        return { authenticated: raw.authenticated, identity: raw.identity ? createHash("sha256").update(raw.identity).digest("hex") : undefined, accountId: raw.accountId };
    }
    async requireAuth(id, page) {
        const status = await this.auth(page);
        const marker = await this.marker(id);
        if (marker.mode === "guest") {
            if (!marker.ready)
                throw new WebError("Finish anonymous browser setup before making requests", 401, "guest_not_ready");
            if (status.authenticated)
                throw new WebError("This anonymous profile is now signed into an account; create an account sign-in instead", 409, "account_changed");
            return { authenticated: false, anonymous: true, ready: true, accountId: "匿名网页" };
        }
        if (!status.authenticated)
            throw new WebError("ChatGPT sign-in is unavailable or expired; sign in again in the plugin browser", 401, "sign_in_required");
        if (!marker.identity)
            throw new WebError("Finish browser sign-in before making requests", 401, "sign_in_required");
        if (marker.identity !== status.identity)
            throw new WebError("The browser is signed into a different account; create a new plugin sign-in", 409, "account_changed");
        return status;
    }
    async checkVerification(page) {
        if (/^(?:Just a moment|请稍候|请稍等)/i.test(await page.title())) {
            throw new WebError("ChatGPT requires browser verification; complete it in the dedicated browser before retrying", 403, "browser_verification_required");
        }
    }
    async waitForComposer(page) {
        await this.checkVerification(page);
        const composer = page.locator(COMPOSER).filter({ visible: true }).first();
        try {
            await composer.waitFor({ state: "visible", timeout: 15_000 });
        }
        catch (e) {
            if (page.isClosed())
                throw new WebError("The chat window was closed", 502, "page_closed");
            await this.checkVerification(page);
            if (e?.name === "TimeoutError")
                throw new WebError("The webpage chat input did not become available; check the dedicated browser", 403, "chat_unavailable");
            throw e;
        }
        return composer;
    }
    async begin(mode, signal, cookies) {
        checkAbort(signal);
        await mkdir(this.options.profilesDir, { recursive: true, mode: 0o700 });
        if ((await lstat(this.options.profilesDir)).isSymbolicLink())
            throw new WebError("profilesDir must not be a symbolic link", 400, "invalid_profiles_directory");
        const profileId = randomUUID();
        await mkdir(this.directory(profileId), { mode: 0o700 });
        await writeFile(join(this.directory(profileId), "magpie-profile.json"), JSON.stringify({ version: 1, profileId, origin: this.origin, mode, browserMode: this.options.browserMode }), { mode: 0o600, flag: "wx" });
        signal = await this.acquire(profileId, signal);
        try {
            const entry = await this.context(profileId, mode === "account");
            if (cookies) {
                try {
                    await entry.context.addCookies(cookies);
                }
                catch {
                    throw new WebError("Unable to install the imported cookies; check the exported JSON format", 400, "cookie_import_failed");
                }
            }
            const page = entry.context.pages()[0] ?? await entry.context.newPage();
            entry.loginPage = page;
            if (cookies || page.url() === "about:blank")
                await page.goto(this.origin, { waitUntil: "domcontentloaded" });
            checkAbort(signal);
            return { profileId };
        }
        finally {
            await this.release(profileId);
        }
    }
    async beginLogin(signal, profileId) {
        if (!profileId)
            return this.begin("account", signal);
        checkAbort(signal);
        const marker = await this.marker(profileId);
        if (marker.mode === "guest")
            throw new WebError("Anonymous profiles cannot be resumed as account logins; create an account profile", 409, "profile_mode_mismatch");
        signal = await this.acquire(profileId, signal);
        try {
            const entry = await this.context(profileId, true);
            const page = entry.context.pages().find(p => p.url().startsWith(this.origin + "/")) ?? entry.context.pages()[0] ?? await entry.context.newPage();
            entry.loginPage = page;
            if (page.url() === "about:blank")
                await page.goto(this.origin, { waitUntil: "domcontentloaded" });
            return { profileId };
        }
        finally {
            await this.release(profileId);
        }
    }
    async beginGuest(signal) { return this.begin("guest", signal); }
    async beginCookieLogin(file, signal) {
        checkAbort(signal);
        const cookies = await readCookieFile(file, this.origin);
        return this.begin("account", signal, cookies);
    }
    async waitLogin(id, signal) {
        signal = await this.acquire(id, signal);
        try {
            const marker = await this.marker(id);
            if (marker.mode === "guest")
                throw new WebError("Anonymous profiles cannot be authenticated as account logins", 409, "profile_mode_mismatch");
            const entry = await this.context(id, true);
            if (!entry.context.pages().length) {
                const page = await entry.context.newPage();
                entry.loginPage = page;
                await page.goto(this.origin, { waitUntil: "domcontentloaded" });
            }
            else {
                const blank = entry.context.pages().find(p => p.url() === "about:blank");
                if (blank && entry.context.pages().length === 1)
                    await blank.goto(this.origin, { waitUntil: "domcontentloaded" });
            }
            const deadline = Date.now() + this.options.loginTimeoutMs;
            while (Date.now() < deadline) {
                checkAbort(signal);
                const pages = entry.context.pages();
                if (!pages.length)
                    throw new WebError("The login window was closed; resume this profile when ready", 401, "login_closed");
                // Login redirects/popups may replace the original tab. Inspect only
                // our site, never credentials or DOM from an identity provider page.
                for (const page of pages) {
                    if (!page.url().startsWith(this.origin + "/"))
                        continue;
                    try {
                        if (!await page.locator(COMPOSER).filter({ visible: true }).first().isVisible())
                            continue;
                        const status = await this.auth(page);
                        if (!status.authenticated)
                            continue;
                        if (marker.identity && marker.identity !== status.identity)
                            throw new WebError("This profile is signed into a different account; create a new account profile", 409, "account_changed");
                        await writeFile(join(this.directory(id), "magpie-profile.json"), JSON.stringify({ ...marker, identity: status.identity }), { mode: 0o600 });
                        entry.loginPage = page;
                        return status;
                    }
                    catch (e) {
                        if (page.isClosed() || /Execution context was destroyed|Cannot find context/i.test(e?.message ?? ""))
                            continue;
                        throw e;
                    }
                }
                await delay(750, signal);
            }
            throw new WebError("Browser sign-in timed out; finish login in the window and resume the same profile", 408, "login_timeout");
        }
        finally {
            await this.release(id);
        }
    }
    async waitGuest(id, signal) {
        signal = await this.acquire(id, signal);
        try {
            const marker = await this.marker(id);
            if (marker.mode !== "guest")
                throw new WebError("This profile was created for account sign-in", 400, "profile_mismatch");
            const entry = await this.context(id);
            const page = entry.loginPage && !entry.loginPage.isClosed() ? entry.loginPage : entry.context.pages().find(p => p.url().startsWith(this.origin + "/")) ?? await entry.context.newPage();
            if (page.url() === "about:blank")
                await page.goto(this.origin, { waitUntil: "domcontentloaded" });
            const deadline = Date.now() + Math.min(this.options.loginTimeoutMs, 60_000);
            while (Date.now() < deadline) {
                checkAbort(signal);
                if (page.isClosed())
                    throw new WebError("The anonymous window was closed", 502, "page_closed");
                if (await page.locator(COMPOSER).filter({ visible: true }).first().isVisible()) {
                    const status = await this.auth(page);
                    if (status.authenticated)
                        throw new WebError("This browser is signed in; use account mode instead", 409, "account_changed");
                    await writeFile(join(this.directory(id), "magpie-profile.json"), JSON.stringify({ ...marker, ready: true }), { mode: 0o600 });
                    return { authenticated: false, anonymous: true, ready: true, accountId: "匿名网页" };
                }
                await delay(750, signal);
            }
            throw new WebError("Anonymous chat is unavailable on this page; check the browser or use account mode", 403, "anonymous_unavailable");
        }
        finally {
            await this.release(id);
        }
    }
    async status(id, signal) {
        signal = await this.acquire(id, signal);
        let page;
        try {
            checkAbort(signal);
            const entry = await this.context(id);
            page = await entry.context.newPage();
            await page.goto(this.origin, { waitUntil: "domcontentloaded" });
            await this.waitForComposer(page);
            const auth = await this.requireAuth(id, page);
            if (!await page.locator(COMPOSER).filter({ visible: true }).first().isVisible())
                throw new WebError("The webpage chat input is unavailable; check the browser window", 403, "chat_unavailable");
            const picker = page.locator(PICKER).first();
            const modelLabel = await picker.isVisible() ? (await picker.innerText()).trim() : undefined;
            const mode = (await this.marker(id)).browserMode ?? "managed";
            return { ...auth, modelLabel, browserMode: mode, windowKeptOpen: mode === "keep-open" };
        }
        finally {
            await page?.close().catch(() => { });
            await this.release(id);
        }
    }
    async selectModel(page, modelId) {
        const model = this.options.models.find(m => m.id === modelId);
        if (!model)
            throw new WebError("Unknown configured model", 400, "unknown_model");
        const picker = page.locator(PICKER).first();
        if (!model.pickerLabel)
            return await picker.isVisible() ? (await picker.innerText()).trim() : "网页当前模型";
        if (!await picker.isVisible())
            throw new WebError("Cannot locate the webpage model picker", 502, "model_picker_missing");
        await picker.click();
        const item = page.getByRole("menuitem", { name: model.pickerLabel, exact: true })
            .or(page.getByRole("menuitemradio", { name: model.pickerLabel, exact: true }))
            .or(page.getByRole("option", { name: model.pickerLabel, exact: true }));
        if (await item.count() !== 1 || !await item.isVisible())
            throw new WebError("The configured model is unavailable; use its exact webpage menu label", 400, "model_unavailable");
        await item.click();
        const label = (await picker.innerText()).trim();
        if (!label.toLocaleLowerCase().includes(model.pickerLabel.toLocaleLowerCase()))
            throw new WebError("The webpage did not confirm the requested model; no message was sent", 502, "model_not_confirmed");
        return label;
    }
    async snapshot(page) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await this.checkVerification(page);
                return await this.readSnapshot(page);
            }
            catch (e) {
                if (page.isClosed() || !/Execution context was destroyed|Cannot find context/i.test(e?.message ?? "") || attempt === 2)
                    throw e;
                await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
            }
        }
        throw new WebError("The page continued navigating; the request was not resent", 502, "page_navigation_failed");
    }
    async readSnapshot(page) {
        return page.evaluate(({ stopSelector, sendSelector }) => {
            const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const identity = (el) => {
                const holder = el.closest("[data-turn-id]");
                const turn = holder?.getAttribute("data-turn-id") ?? el.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container");
                const message = el.getAttribute("data-message-id") ?? el.closest("[data-message-id]")?.getAttribute("data-message-id");
                return turn ? `turn:${turn}` : message ? `message:${message}` : "";
            };
            const seen = new Set();
            for (const el of document.querySelectorAll("[data-turn-id], [data-turn-id-container], [data-message-id]")) {
                for (const [attr, prefix] of [["data-turn-id", "turn"], ["data-turn-id-container", "turn"], ["data-message-id", "message"]]) {
                    const v = el.getAttribute(attr);
                    if (v)
                        seen.add(`${prefix}:${v}`);
                }
            }
            const users = [];
            const assistants = [];
            const answerSelector = '.markdown, [data-markdown-text-style="assistant-message"], .puik-root.not-markdown > [class*="_DilResponseRoot"]';
            const noiseSelector = 'button, svg, script, style, .sr-only, [aria-hidden="true"], [data-streaming-response-status], [data-testid="thinking-summary"], [data-testid="reasoning-summary"], [data-testid^="cot-v5"]';
            // The anonymous lightweight page uses transcript list IDs and an explicit
            // completion attribute instead of the account page's turn containers.
            for (const el of document.querySelectorAll('[data-conversation-transcript] li[id]')) {
                seen.add(`mobile:user:${el.id}`);
                seen.add(`mobile:assistant:${el.id}`);
                if (!visible(el))
                    continue;
                const role = el.getAttribute('data-message-role');
                if (role === 'user') {
                    users.push(`mobile:user:${el.id}`);
                    continue;
                }
                if (role !== 'assistant')
                    continue;
                const roots = [...el.querySelectorAll('[data-assistant-markdown]')].filter(root => visible(root) && !root.closest('[data-streaming-response-status], [data-testid^="cot-v5"]'));
                const html = roots.map(root => {
                    const content = root.cloneNode(true);
                    for (const noise of content.querySelectorAll(noiseSelector))
                        noise.remove();
                    return content.innerHTML;
                }).join('\n');
                assistants.push({ id: `mobile:assistant:${el.id}`, html, complete: el.hasAttribute('data-message-complete') });
            }
            for (const group of document.querySelectorAll('[data-turn-key]')) {
                const key = group.getAttribute('data-turn-key');
                if (!key)
                    continue;
                // Reserve both identities even while historical content is virtualized.
                seen.add(`group:user:${key}`);
                seen.add(`group:assistant:${key}`);
                const bubble = group.querySelector('[data-user-message-bubble]');
                if (bubble && visible(bubble))
                    users.push(`group:user:${key}`);
                if (!group.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]'))
                    continue;
                const activities = [...group.querySelectorAll('[data-chatgpt-agent-turn-start]')].map(el => el.parentElement);
                const roots = [...group.querySelectorAll(answerSelector)].filter(el => {
                    if (!visible(el) || el.parentElement?.closest(answerSelector) || el.closest('[data-user-message-bubble], [data-conversation-role="user"], [data-streaming-response-status], [data-testid^="cot-v5"], [data-testid="thinking-summary"], [data-testid="reasoning-summary"]'))
                        return false;
                    const unit = el.closest('[data-content-search-unit-key]');
                    if (unit)
                        return Boolean(unit.querySelector('[data-conversation-role="assistant"]'));
                    if (activities.some(activity => activity?.contains(el)))
                        return false;
                    return Boolean(el.closest('[data-conversation-role="assistant"], [data-message-author-role="assistant"]'));
                });
                if (!roots.length)
                    continue;
                const html = roots.map(root => {
                    const content = root.cloneNode(true);
                    for (const noise of content.querySelectorAll(noiseSelector))
                        noise.remove();
                    return content.innerHTML;
                }).join('\n');
                const last = roots.at(-1);
                const complete = [...group.querySelectorAll('.turn-action-controls button, [data-testid="copy-turn-action-button"], [data-testid="copy-turn-action"]')]
                    .some(button => !button.closest('[data-user-message-bubble], [data-conversation-role="user"]') && Boolean(last.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING));
                assistants.push({ id: `group:assistant:${key}`, html, complete });
            }
            for (const el of document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')) {
                if (el.closest('[data-turn-key]'))
                    continue;
                const id = identity(el);
                if (!id || !visible(el))
                    continue;
                if (el.getAttribute("data-message-author-role") === "user") {
                    users.push(id);
                    continue;
                }
                const content = el.cloneNode(true);
                for (const noise of content.querySelectorAll(noiseSelector))
                    noise.remove();
                const markdown = [...content.querySelectorAll(answerSelector)].filter(el => !el.parentElement?.closest(answerSelector));
                const html = markdown.length ? markdown.map(n => n.innerHTML).join("\n") : content.innerHTML;
                const wrapper = el.closest("[data-turn-id], [data-turn-id-container], article") ?? el.parentElement;
                const complete = Boolean(wrapper?.querySelector('[data-testid="copy-turn-action-button"], [data-testid="copy-turn-action"]'));
                assistants.push({ id, html, complete });
            }
            const stop = [...document.querySelectorAll(stopSelector)].some(visible);
            const sendReady = !stop && [...document.querySelectorAll(sendSelector)].some(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
            const alerts = [...document.querySelectorAll('[role="alert"], [data-testid="conversation-turn-error"]')].filter(visible).map(el => el.textContent?.trim() ?? "").filter(Boolean);
            return { seen: [...seen], users, assistants, generating: stop, sendReady, alerts };
        }, { stopSelector: STOP, sendSelector: SEND });
    }
    checkAlerts(snapshot) {
        for (const text of snapshot.alerts) {
            if (/rate limit|too many requests|limit reached|you.ve hit|达到.*上限|已达.*上限|请求过多|頻率限制/i.test(text))
                throw new WebError("ChatGPT reported a usage or rate limit; wait before retrying", 429, "upstream_rate_limit");
            if (/something went wrong|unable to generate|error generating|出错了|发生错误|生成.*错误/i.test(text))
                throw new WebError("ChatGPT reported a generation error; check the browser window", 502, "upstream_generation_error");
        }
    }
    async *complete(id, completion, signal) {
        signal = await this.acquire(id, signal);
        let page;
        let completed = false;
        let released = false;
        let stopOnAbort;
        try {
            checkAbort(signal);
            const entry = await this.context(id);
            page = await entry.context.newPage();
            const ownedPage = page;
            stopOnAbort = () => {
                void (async () => {
                    const stop = ownedPage.locator(STOP).first();
                    if (await stop.isVisible().catch(() => false))
                        await stop.click({ timeout: 1_000 }).catch(() => { });
                    await ownedPage.close().catch(() => { });
                })();
            };
            signal?.addEventListener("abort", stopOnAbort, { once: true });
            checkAbort(signal);
            await page.goto(this.origin, { waitUntil: "domcontentloaded" });
            let composer;
            try {
                composer = await this.waitForComposer(page);
            }
            catch (e) {
                const slug = this.options.models.find(model => model.id === completion.model)?.backendSlug;
                if (!(e instanceof WebError) || e.code !== "chat_unavailable" || !this.options.internalSender || !slug)
                    throw e;
                await this.checkVerification(page);
            }
            await this.requireAuth(id, page);
            const label = await this.selectModel(page, completion.model);
            const baseline = await this.snapshot(page);
            if (baseline.generating)
                throw new WebError("A webpage response is already running", 409, "page_busy");
            let seen = new Set(baseline.seen);
            await composer?.fill(completion.prompt);
            checkAbort(signal);
            let send = page.locator(SEND).filter({ visible: true }).first();
            if ((!composer || !await send.isVisible()) && this.options.internalSender) {
                const slug = this.options.models.find(model => model.id === completion.model)?.backendSlug;
                if (slug) {
                    const text = await sendInternal(page, completion.prompt, slug, this.options.timeoutMs, this.options.maxOutputChars, signal, (await this.marker(id)).identity);
                    checkAbort(signal);
                    if (text !== undefined) {
                        yield { event: "ready", modelLabel: label };
                        yield { event: "delta", text };
                        completed = true;
                    }
                    else {
                        // Preflight declined before POST: a fresh DOM attempt is still permitted.
                        await page.reload({ waitUntil: "domcontentloaded" });
                        const recoveredComposer = await this.waitForComposer(page);
                        composer = recoveredComposer;
                        await this.requireAuth(id, page);
                        await this.selectModel(page, completion.model);
                        const recovered = await this.snapshot(page);
                        if (recovered.generating)
                            throw new WebError("A webpage response is already running", 409, "page_busy");
                        seen = new Set(recovered.seen);
                        await recoveredComposer.fill(completion.prompt);
                        checkAbort(signal);
                        send = page.locator(SEND).filter({ visible: true }).first();
                    }
                }
            }
            if (completed) {
                await page.close();
                page = undefined;
                if (stopOnAbort)
                    signal?.removeEventListener("abort", stopOnAbort);
                await this.release(id);
                released = true;
                checkAbort(signal);
                yield { event: "done" };
                return;
            }
            if (!composer || !await send.isVisible())
                throw new WebError("Cannot locate the webpage input or Send button; no message was sent", 502, "send_button_missing");
            const submission = new Submission();
            submission.attempt();
            await send.click();
            const deadline = Date.now() + this.options.timeoutMs;
            const acceptedDeadline = Math.min(deadline, Date.now() + 15_000);
            let userId;
            let assistantId;
            let ready = false, sawGenerating = false, lastText = "", stableSince = Date.now();
            const output = new MarkdownStream();
            let nextInternalRead = Date.now() + 5000;
            while (Date.now() < deadline) {
                checkAbort(signal);
                if (page.isClosed())
                    throw new WebError("The conversation window was closed", 502, "page_closed");
                const snapshot = await this.snapshot(page);
                this.checkAlerts(snapshot);
                const newUsers = [...new Set(snapshot.users.filter(v => !seen.has(v)))];
                if (newUsers.length > 1 || (userId && newUsers.some(v => v !== userId)))
                    throw new WebError("Another message appeared in this conversation; the request cannot be bound safely", 409, "ambiguous_turn");
                if (!userId)
                    userId = newUsers[0];
                if (!userId) {
                    if (Date.now() > acceptedDeadline)
                        throw new WebError("The webpage did not confirm a new user message; no automatic resend was attempted", 502, "send_unconfirmed");
                    await delay(this.options.pollMs, signal);
                    continue;
                }
                if (!ready) {
                    submission.confirm();
                    ready = true;
                    yield { event: "ready", modelLabel: label };
                }
                sawGenerating ||= snapshot.generating;
                // Anonymous pages insert an empty pending-* item, then replace its ID
                // with the server's message ID. Bind only substantive rendered replies.
                const candidates = snapshot.assistants.filter(a => !seen.has(a.id)).map(a => ({ ...a, text: toMarkdown(a.html) })).filter(a => a.text);
                if (candidates.length > 1 || (assistantId && candidates.some(a => a.id !== assistantId)))
                    throw new WebError("The webpage returned ambiguous assistant messages", 502, "ambiguous_response");
                const answer = candidates[0];
                if (answer) {
                    if (userId.startsWith("group:user:") && answer.id !== `group:assistant:${userId.slice("group:user:".length)}`)
                        throw new WebError("The assistant reply belongs to another message group", 502, "ambiguous_response");
                    assistantId ??= answer.id;
                    const text = answer.text;
                    if (text.length > this.options.maxOutputChars)
                        throw new WebError("The webpage reply exceeds maxOutputChars", 502, "output_too_large");
                    if (text !== lastText) {
                        stableSince = Date.now();
                        lastText = text;
                    }
                    const done = Boolean(text) && !snapshot.generating && (answer.complete || (sawGenerating && snapshot.sendReady && Date.now() - stableSince >= this.options.settleMs));
                    const delta = output.update(text, done);
                    if (delta)
                        yield { event: "delta", text: delta };
                    if (done) {
                        submission.complete();
                        completed = true;
                        break;
                    }
                }
                if (this.options.internalReader && Date.now() >= nextInternalRead && Date.now() - stableSince >= 5000) {
                    nextInternalRead = Date.now() + 5000;
                    const nativeId = userId.replace(/^(?:.*:user:|turn:|message:)/, "");
                    const internal = await readInternalReply(page, nativeId, this.options.maxOutputChars, (await this.marker(id)).identity);
                    checkAbort(signal);
                    // A different serialization cannot replace an already emitted prefix.
                    if (internal?.complete && internal.text.startsWith(output.text)) {
                        const delta = output.update(internal.text, true);
                        if (delta)
                            yield { event: "delta", text: delta };
                        submission.complete();
                        completed = true;
                        break;
                    }
                }
                await delay(this.options.pollMs, signal);
            }
            if (!completed)
                throw new WebError("The webpage reply timed out; a partial reply was not reported as successful", 504, "generation_timeout");
        }
        catch (e) {
            checkAbort(signal);
            throw e;
        }
        finally {
            if (stopOnAbort)
                signal?.removeEventListener("abort", stopOnAbort);
            if (page && !page.isClosed() && !completed) {
                const stop = page.locator(STOP).first();
                if (await stop.isVisible().catch(() => false))
                    await stop.click({ timeout: 1_000 }).catch(() => { });
            }
            await page?.close().catch(() => { });
            if (!released)
                await this.release(id);
        }
        // A successful API finish must also mean the next request can acquire this
        // account. Never publish DONE while the browser cleanup still owns it.
        checkAbort(signal);
        yield { event: "done" };
    }
    /**
     * Answers with a locally drawn picture, so the gateway's image routing and response parsing can
     * be checked without signing in and without spending anyone's quota. Reached only while the
     * `imageSelfTest` option is on, and every result says so.
     */
    async selfTestImage(id, request) {
        const started = Date.now();
        const rendered = imagePrompt({ ...request, promptSuffix: request.promptSuffix ?? this.options.imagePromptSuffix });
        const images = await saveImages(request.outputDir || this.options.imageDir, [selfTestPayload()], request.filename ?? "chatgpt-web-selftest");
        return {
            success: true,
            profileId: id,
            model: request.model ?? "web-image",
            modelLabel: "self-test (imageSelfTest is on; no webpage was used)",
            prompt: rendered.prompt,
            ...(rendered.ratio && request.size ? { requestedSize: request.size } : {}),
            requestedCount: Math.max(1, Math.min(request.n ?? 1, 4)),
            images,
            text: "",
            elapsedMs: Date.now() - started,
            warnings: ["imageSelfTest is on: this picture was drawn locally, no ChatGPT webpage was used"],
        };
    }
    /**
     * Reads every assistant turn the page currently renders, with the images inside it. The
     * bytes are only carried when `extract` is set, so the polling path stays small even while
     * a data: URL is on screen.
     */
    async readImages(page, extract) {
        const raw = await page.evaluate(async ({ wantBytes, chunk }) => {
            const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            // A generated picture is served from the page's own origin, an oaiusercontent asset or a
            // blob/data URL. Icons, avatars and inline SVG placeholders are filtered out by size and
            // scheme. Anything else (a UI sprite, a favicon) never sits at 96px or more.
            const accepted = (src) => {
                if (!src)
                    return false;
                if (/^data:image\/svg/i.test(src))
                    return false;
                if (/^data:image\//i.test(src))
                    return true;
                if (/^blob:/i.test(src))
                    return true;
                try {
                    const u = new URL(src, location.href);
                    if (u.protocol !== "https:" && u.protocol !== "http:")
                        return false;
                    return /(^|\.)oaiusercontent\.com$/.test(u.hostname) || /(^|\.)openai\.com$/.test(u.hostname) || u.origin === location.origin;
                }
                catch {
                    return false;
                }
            };
            const turns = [];
            const push = (el, id) => { if (el && id && !turns.some(t => t.el === el))
                turns.push({ el, id }); };
            for (const group of document.querySelectorAll("[data-turn-key]")) {
                const key = group.getAttribute("data-turn-key");
                if (!key)
                    continue;
                if (!group.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]'))
                    continue;
                push(group, `group:assistant:${key}`);
            }
            for (const li of document.querySelectorAll('[data-conversation-transcript] li[id][data-message-role="assistant"]')) {
                push(li, `mobile:assistant:${li.id}`);
            }
            for (const el of document.querySelectorAll('[data-message-author-role="assistant"]')) {
                if (el.closest("[data-turn-key]"))
                    continue;
                const turn = el.closest("[data-turn-id]")?.getAttribute("data-turn-id") ?? el.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container");
                const message = el.getAttribute("data-message-id") ?? el.closest("[data-message-id]")?.getAttribute("data-message-id");
                const id = turn ? `turn:${turn}` : message ? `message:${message}` : "";
                push(el.closest("article") ?? el.parentElement ?? el, id);
            }
            const encode = (buf) => {
                let out = "";
                for (let i = 0; i < buf.length; i += chunk)
                    out += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)));
                return btoa(out);
            };
            const result = [];
            for (const { el, id } of turns) {
                const nodes = [...el.querySelectorAll("img")].filter(node => {
                    if (!visible(node))
                        return false;
                    const src = node.currentSrc || node.src || "";
                    if (!accepted(src))
                        return false;
                    // The turn also renders the caller's uploaded reference and the account avatar. Those
                    // are not drawings: a reference picture must never come back as the generated answer.
                    const alt = (node.getAttribute("alt") ?? "").trim().toLowerCase();
                    if (alt === "user attachment" || alt.includes("attachment") || alt.includes("avatar"))
                        return false;
                    return node.naturalWidth >= 96 && node.naturalHeight >= 96;
                }).sort((a, b) => {
                    const score = (node) => (/generated image/i.test(node.getAttribute("alt") ?? "") ? 0 : 1);
                    return score(a) - score(b);
                });
                const images = [];
                for (let index = 0; index < nodes.length; index++) {
                    const node = nodes[index];
                    const src = node.currentSrc || node.src || "";
                    const key = src.startsWith("data:") ? `data:${src.length}` : src.slice(0, 400);
                    const entry = {
                        index, src, key,
                        width: node.naturalWidth, height: node.naturalHeight,
                        alt: (node.getAttribute("alt") ?? "").slice(0, 300),
                    };
                    if (wantBytes) {
                        try {
                            const response = await fetch(src, { credentials: "include" });
                            if (!response.ok)
                                entry.error = `HTTP ${response.status}`;
                            else {
                                const buffer = new Uint8Array(await response.arrayBuffer());
                                if (buffer.byteLength === 0)
                                    entry.error = "empty response";
                                else if (buffer.byteLength > 48 * 1024 * 1024)
                                    entry.error = "image exceeds 48 MiB";
                                else {
                                    entry.b64 = encode(buffer);
                                    entry.mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
                                    entry.bytes = buffer.byteLength;
                                }
                            }
                        }
                        catch (e) {
                            entry.error = String(e?.message ?? e).slice(0, 200);
                        }
                    }
                    images.push(entry);
                }
                result.push({ id, text: (el.textContent ?? "").slice(0, 4_000), images });
            }
            return result;
        }, { wantBytes: extract, chunk: 0x8000 });
        return raw;
    }
    /** The bytes of one candidate, read through the browser context when the page's own fetch is refused. */
    async fetchImage(context, image) {
        if (image.b64 && image.bytes) {
            const bytes = Buffer.from(image.b64, "base64");
            return { bytes, mimeType: image.mimeType || sniffMime(bytes) || "image/png", url: image.src, via: "page-fetch" };
        }
        if (/^blob:/i.test(image.src) || /^data:/i.test(image.src)) {
            throw new WebError(`The page could not read the generated image (${image.error ?? "unknown error"}); blob and data URLs cannot be fetched outside the page`, 502, "image_bytes_unavailable");
        }
        try {
            const response = await context.request.get(image.src, { timeout: 60_000 });
            if (!response.ok())
                throw new WebError(`the asset answered HTTP ${response.status()}`, 502, "image_fetch_failed");
            const bytes = await response.body();
            if (!bytes.length)
                throw new WebError("the asset answered with no bytes", 502, "image_fetch_failed");
            const mimeType = (response.headers()["content-type"] ?? "").split(";")[0].trim();
            return { bytes, mimeType: mimeType || sniffMime(bytes) || "image/png", url: image.src, via: "context-request" };
        }
        catch (e) {
            const detail = e instanceof WebError ? e.message : `the asset could not be read (${e?.message ?? e})`;
            throw new WebError(`The generated image could not be downloaded: ${detail}`, 502, "image_fetch_failed");
        }
    }
    /**
     * Uploads the caller's reference pictures into the composer before the prompt is sent. The
     * webpage keeps hidden `input[type=file]` elements mounted for photo/video attachments, so the
     * upload goes through the same path a person uses; no request is made to any API endpoint.
     */
    /** Removes leftover attachment chips and text so a failed attempt cannot poison the next one. */
    async clearComposer(page) {
        const chips = page.locator('form button[aria-label^="Remove "]');
        for (let i = 0, n = await chips.count().catch(() => 0); i < n && i < 8; i++) {
            await chips.first().click({ timeout: 2_000 }).catch(() => { });
            await delay(200);
        }
        const composer = page.locator(COMPOSER).filter({ visible: true }).first();
        if (await composer.count().catch(() => 0)) {
            await composer.click({ timeout: 5_000 }).catch(() => { });
            await page.keyboard.press("Control+a").catch(() => { });
            await page.keyboard.press("Backspace").catch(() => { });
        }
    }
    /** True while the composer shows a failed attachment ("Upload failed"). */
    async uploadFailed(page) {
        const text = await page.locator("form").first().innerText().catch(() => "");
        return /upload failed|上传失败|upload error/i.test(text);
    }
    async attachReferences(page, references, warnings) {
        const input = page.locator(ATTACH).first();
        if (!await input.count())
            throw new WebError("The webpage composer has no image attachment input; the reference picture cannot be uploaded", 502, "reference_input_missing");
        const chips = page.locator('form button[aria-label^="Remove "]');
        for (const reference of references) {
            const before = await chips.count().catch(() => 0);
            try {
                await input.setInputFiles(reference.path, { timeout: 30_000 });
            }
            catch (e) {
                throw new WebError(`The reference picture could not be attached: ${e?.message ?? e}`, 502, "reference_upload_failed");
            }
            const deadline = Date.now() + 60_000;
            let attached = false;
            while (Date.now() < deadline) {
                if (await this.uploadFailed(page)) {
                    await this.clearComposer(page);
                    throw new WebError("The webpage refused the reference picture (upload failed)", 502, "reference_upload_failed");
                }
                if (await chips.count().catch(() => before) > before) {
                    attached = true;
                    break;
                }
                await delay(this.options.pollMs);
            }
            if (!attached) {
                await this.clearComposer(page);
                throw new WebError("The webpage did not accept the reference picture", 502, "reference_upload_failed");
            }
        }
        // The send button stays disabled while an upload is still in flight; wait for it, then let the
        // attachment settle so the prompt and the picture travel in the same turn.
        const send = page.locator(SEND).filter({ visible: true }).first();
        const uploadDeadline = Date.now() + 60_000;
        while (Date.now() < uploadDeadline) {
            if (await this.uploadFailed(page)) {
                await this.clearComposer(page);
                throw new WebError("The webpage refused the reference picture (upload failed)", 502, "reference_upload_failed");
            }
            if (await send.isEnabled().catch(() => false))
                break;
            await delay(this.options.pollMs);
        }
        await delay(1_500);
        warnings.push(`${references.length} reference picture(s) uploaded through the webpage composer`);
    }
    static IMAGE_REFUSAL = /(?:can'?t|cannot|unable to|won'?t|wasn'?t able to|not able to)\s+(?:generate|create|make|produce|draw)|content policy|violates? (?:our|the) (?:policies|usage)|无法(?:生成|创建|绘制|满足)|不能生成|违反.{0,8}(?:政策|规定)|未能生成|生成失败/i;
    /**
     * Text-to-image through the logged-in ChatGPT web image tool.
     *
     * This is the webpage route only: the prompt goes into the composer, the picture is read back
     * out of the rendered assistant turn. No OpenAI API, Images API or Codex endpoint is used, and
     * no browser session material leaves the dedicated profile.
     */
    async generateImage(id, request, signal) {
        if (this.options.imageSelfTest)
            return await this.selfTestImage(id, request);
        signal = await this.acquire(id, signal);
        const started = Date.now();
        const warnings = [];
        let page;
        let completed = false;
        let released = false;
        let reused = false;
        let stopOnAbort;
        try {
            checkAbort(signal);
            const marker = await this.marker(id);
            const entry = await this.context(id);
            // Cloudflare hands a fresh tab a "Just a moment" challenge that never settles in a
            // remote/headless display, while a tab the account already opened stays cleared.
            // Reuse that warm tab when one exists and never navigate it away from the site.
            const warm = entry.context.pages().find(p => !p.isClosed() && p.url().startsWith(this.origin));
            page = warm ?? await entry.context.newPage();
            reused = Boolean(warm);
            const ownedPage = page;
            stopOnAbort = () => {
                void (async () => {
                    const stop = ownedPage.locator(STOP).first();
                    if (await stop.isVisible().catch(() => false))
                        await stop.click({ timeout: 1_000 }).catch(() => { });
                    if (!reused)
                        await ownedPage.close().catch(() => { });
                })();
            };
            signal?.addEventListener("abort", stopOnAbort, { once: true });
            checkAbort(signal);
            // Keep whatever picture the page already downloaded: a blob: URL or a signed
            // oaiusercontent asset is not always readable a second time.
            const captured = new Map();
            const onResponse = (response) => {
                void (async () => {
                    try {
                        const type = (response.headers()["content-type"] ?? "").toLowerCase();
                        if (!type.startsWith("image/"))
                            return;
                        if (captured.size >= 8)
                            return;
                        const url = response.url();
                        if (!url || captured.has(url))
                            return;
                        const body = await response.body();
                        if (!body.length || body.length > 48 * 1024 * 1024)
                            return;
                        captured.set(url, { bytes: body, mimeType: type.split(";")[0].trim(), url, via: "network" });
                    }
                    catch { /* a blob: response has no readable body here */ }
                })();
            };
            page.on("response", onResponse);
            // Refused before the page is even read: the live anonymous landing page says sign-in is
            // what unlocks image creation, so a guest profile can never answer this.
            if (marker.mode === "guest")
                throw new WebError("Image generation needs a signed-in ChatGPT account; the anonymous webpage session cannot draw pictures", 401, "image_requires_account");
            if (!reused)
                await page.goto(this.origin, { waitUntil: "domcontentloaded" });
            await this.waitForComposer(page);
            await this.requireAuth(id, page);
            const modelId = request.model ?? this.options.models[0].id;
            const label = await this.selectModel(page, modelId);
            const rendered = imagePrompt({ ...request, promptSuffix: request.promptSuffix ?? this.options.imagePromptSuffix });
            const baseline = await this.snapshot(page);
            if (baseline.generating)
                throw new WebError("A webpage response is already running", 409, "page_busy");
            const seen = new Set(baseline.seen);
            const baselineTurns = new Set((await this.readImages(page, false)).map(t => t.id));
            // Every picture already on the page (the uploaded reference included) is excluded from the
            // answer, so the request can only return what this turn produced.
            const baselineImages = new Set((await this.readImages(page, false)).flatMap(t => t.images.map(i => i.src)));
            const composer = await this.waitForComposer(page);
            await this.clearComposer(page);
            if (request.references?.length)
                await this.attachReferences(page, request.references, warnings);
            await composer.fill(rendered.prompt);
            checkAbort(signal);
            const send = page.locator(SEND).filter({ visible: true }).first();
            if (!await send.isVisible())
                throw new WebError("Cannot locate the webpage Send button; no message was sent", 502, "send_button_missing");
            await send.click();
            const timeout = Math.min(request.timeoutMs ?? this.options.imageTimeoutMs, this.options.imageTimeoutMs);
            const deadline = Date.now() + timeout;
            const acceptedDeadline = Math.min(deadline, Date.now() + 15_000);
            let userId;
            let assistantId;
            let sawGenerating = false;
            let signature = "";
            let signatureSince = 0;
            let turnText = "";
            let extracting;
            let stoppedAt = 0;
            let lastTurnCount = 0;
            while (Date.now() < deadline) {
                checkAbort(signal);
                if (page.isClosed())
                    throw new WebError("The conversation window was closed", 502, "page_closed");
                const snapshot = await this.snapshot(page);
                this.checkAlerts(snapshot);
                const fresh = [...new Set(snapshot.users.filter(v => !seen.has(v)))];
                if (fresh.length > 1 || (userId && fresh.some(v => v !== userId)))
                    throw new WebError("Another message appeared in this conversation; the request cannot be bound safely", 409, "ambiguous_turn");
                if (!userId)
                    userId = fresh[0];
                if (!userId) {
                    if (Date.now() > acceptedDeadline)
                        throw new WebError("The webpage did not confirm a new user message; no automatic resend was attempted", 502, "send_unconfirmed");
                    await delay(this.options.pollMs, signal);
                    continue;
                }
                sawGenerating ||= snapshot.generating;
                lastTurnCount = snapshot.assistants.filter(a => !seen.has(a.id)).length;
                const turns = (await this.readImages(page, false)).map(t => ({ ...t, images: t.images.filter(i => !baselineImages.has(i.src)) }));
                const unseen = turns.filter(t => !baselineTurns.has(t.id));
                if (unseen.length > 1 || (assistantId && unseen.some(t => t.id !== assistantId)))
                    throw new WebError("The webpage returned ambiguous assistant messages", 502, "ambiguous_response");
                const turn = unseen[0];
                if (turn) {
                    assistantId ??= turn.id;
                    turnText = turn.text;
                    const next = turn.images.map(i => i.key).join("|");
                    if (next !== signature) {
                        signature = next;
                        signatureSince = Date.now();
                    }
                    if (turn.images.length && !extracting) {
                        const settled = !snapshot.generating && Date.now() - signatureSince >= this.options.settleMs;
                        if (settled) {
                            const extracted = await this.readImages(page, true);
                            const full = extracted.find(t => t.id === turn.id);
                            if (full?.images.length)
                                extracting = full;
                        }
                    }
                }
                if (extracting) {
                    completed = true;
                    break;
                }
                if (!snapshot.generating) {
                    if (!stoppedAt && (sawGenerating || (turn && turn.text)))
                        stoppedAt = Date.now();
                    // ChatGPT often writes a sentence, then calls the image tool. Give the page a grace
                    // period before declaring that no picture is coming; it never outlasts the timeout.
                    if (stoppedAt && Date.now() - stoppedAt > Math.min(25_000, Math.max(2_000, timeout / 4)))
                        break;
                }
                else
                    stoppedAt = 0;
                await delay(this.options.pollMs, signal);
            }
            if (!extracting) {
                const detail = turnText.replace(/\s+/g, " ").trim().slice(0, 400);
                if (BrowserRuntime.IMAGE_REFUSAL.test(turnText))
                    throw new WebError(`ChatGPT did not draw a picture; the webpage answered: ${detail || "(no text)"}`, 502, "image_refused");
                if (!userId)
                    throw new WebError("The webpage never confirmed the prompt; no image was read", 502, "send_unconfirmed");
                if (Date.now() >= deadline)
                    throw new WebError(`The webpage produced no image within ${Math.round(timeout / 1000)}s`, 504, "image_timeout");
                throw new WebError(`The webpage answered without an image${detail ? `: ${detail}` : ""}`, 502, "image_not_generated");
            }
            const wanted = Math.max(1, Math.min(request.n ?? 1, 4));
            const candidates = extracting.images.slice(0, wanted * 2);
            const payloads = [];
            for (const image of candidates) {
                if (payloads.length >= wanted)
                    break;
                const cached = captured.get(image.src);
                if (cached) {
                    payloads.push(cached);
                    continue;
                }
                try {
                    payloads.push(await this.fetchImage(entry.context, image));
                }
                catch (e) {
                    if (candidates.length - payloads.length <= 1 && payloads.length === 0)
                        throw e;
                    warnings.push(`one image could not be read: ${e.message}`);
                }
            }
            if (!payloads.length)
                throw new WebError("The webpage showed an image but none of its bytes could be read", 502, "image_unreadable");
            const images = await saveImages(request.outputDir || this.options.imageDir, payloads, request.filename ?? this.options.imageFileName);
            for (const image of images)
                if (!image.width || !image.height)
                    warnings.push(`${image.filename}: unknown picture dimensions`);
            return {
                success: true,
                profileId: id,
                model: modelId,
                modelLabel: label,
                prompt: rendered.prompt,
                ...(rendered.ratio ? { requestedSize: request.size?.trim() ?? rendered.ratio } : {}),
                requestedCount: wanted,
                images,
                text: turnText.replace(/\s+/g, " ").trim().slice(0, 2_000),
                elapsedMs: Date.now() - started,
                warnings,
            };
        }
        finally {
            if (stopOnAbort)
                signal?.removeEventListener("abort", stopOnAbort);
            if (page && !page.isClosed() && !completed) {
                const stop = page.locator(STOP).first();
                if (await stop.isVisible().catch(() => false))
                    await stop.click({ timeout: 1_000 }).catch(() => { });
            }
            if (!completed && page && !page.isClosed())
                await this.clearComposer(page).catch(() => { });
            if (!reused)
                await page?.close().catch(() => { });
            if (!released)
                await this.release(id);
        }
    }
    /**
     * Diagnostic read-back: saves the newest picture the open conversation already shows, without
     * sending anything. It exists so the extraction step can be checked against a real page — the
     * difference between "the webpage drew it" and "the plugin returned the caller's own upload".
     */
    async latestImage(id, request, signal) {
        signal = await this.acquire(id, signal);
        const started = Date.now();
        let page;
        let keptOpen = false;
        try {
            checkAbort(signal);
            const entry = await this.context(id);
            const warm = entry.context.pages().find(p => !p.isClosed() && p.url().startsWith(this.origin));
            if (!warm)
                throw new WebError("No ChatGPT tab is open in the dedicated browser", 404, "no_open_conversation");
            page = warm;
            keptOpen = true;
            await this.waitForComposer(page);
            const turns = (await this.readImages(page, true)).filter(t => t.images.length);
            const turn = turns[turns.length - 1];
            if (!turn)
                throw new WebError("The open conversation shows no picture", 404, "no_image_in_conversation");
            const image = turn.images[0];
            const payload = await this.fetchImage(entry.context, image);
            const images = await saveImages(request.outputDir || this.options.imageDir, [payload], request.filename ?? "chatgpt-web-last");
            return {
                success: true, profileId: id, model: "web-current", modelLabel: "read back from the open conversation",
                prompt: "", requestedCount: 1, images, text: turn.text.replace(/\s+/g, " ").trim().slice(0, 2_000),
                elapsedMs: Date.now() - started, warnings: ["read-back only: nothing was sent to the webpage"],
            };
        }
        finally {
            if (!keptOpen)
                await page?.close().catch(() => { });
            await this.release(id);
        }
    }
    async close() {
        this.closed = true;
        for (const lease of this.leases.values())
            lease.abort();
        const entries = [...this.entries.values()];
        this.entries.clear();
        for (const e of entries)
            if (e.timer)
                clearTimeout(e.timer);
        await Promise.allSettled(entries.map(e => e.disconnect()));
    }
}
