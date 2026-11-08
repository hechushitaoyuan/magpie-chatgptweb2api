#!/usr/bin/env node
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BrowserBridge } from "./bridge.js";
import { parseOptions } from "./options.js";
import { prepare } from "./protocol.js";
import { publicError, WebError } from "./errors.js";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
        options: { type: "string" }, profile: { type: "string" }, model: { type: "string", default: "web-current" },
        prompt: { type: "string" }, "prompt-file": { type: "string" },
        cookies: { type: "string" },
        size: { type: "string" }, quality: { type: "string" }, out: { type: "string" },
        n: { type: "string" }, filename: { type: "string" }, "prompt-suffix": { type: "string" },
        "image-timeout": { type: "string" }, reference: { type: "string", multiple: true }, "extract-last": { type: "boolean" }, json: { type: "boolean" },
    } });
const options = parseOptions(values.options ? JSON.parse(await readFile(values.options, "utf8")) : {});
const bridge = new BrowserBridge(options);
const ctl = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => ctl.abort());
try {
    const command = positionals[0] ?? "help";
    if (values.cookies !== undefined && command !== "login")
        throw new WebError("--cookies is only supported with login", 400, "invalid_command");
    const selectedFile = join(options.profilesDir, "cli-profile.json");
    if (command === "login" || command === "guest") {
        const guest = command === "guest";
        const imported = values.cookies !== undefined;
        if (values.profile && (guest || imported))
            throw new WebError("--profile login cannot be combined with guest or Cookie import", 400, "invalid_command");
        const { profileId } = await bridge.call(guest ? "guestBegin" : imported ? "cookieBegin" : "loginBegin", imported ? { file: values.cookies } : values.profile ? { profileId: values.profile } : {}, ctl.signal);
        process.stderr.write(guest ? "已打开匿名 ChatGPT 浏览器，正在验证聊天输入框。\n" : imported ? "Cookie 已导入专用浏览器，正在验证账号。若网页要求登录或验证，请在该窗口处理。\n" : "正在连接专用浏览器。请登录 ChatGPT；程序完成后，保持窗口模式会保留窗口。\n");
        process.stderr.write(`专用 profile: ${profileId}\n`);
        if (options.remoteLoginUrl)
            process.stderr.write(`远程专用浏览器：${options.remoteLoginUrl}（需预先配置访问保护）\n`);
        const result = await bridge.call(guest ? "guestWait" : "loginWait", { profileId }, ctl.signal);
        await mkdir(options.profilesDir, { recursive: true, mode: 0o700 });
        try {
            if ((await lstat(selectedFile)).isSymbolicLink())
                throw new WebError("CLI profile marker must not be a symlink", 400, "invalid_profile");
        }
        catch (e) {
            if (!(e instanceof Error && "code" in e && e.code === "ENOENT"))
                throw e;
        }
        await writeFile(selectedFile, JSON.stringify({ profileId }), { mode: 0o600 });
        process.stderr.write(`${guest ? "匿名会话已就绪" : "登录已完成"}。CLI profile: ${profileId}\n`);
        if (result.accountId && !guest)
            process.stderr.write("账号身份已验证，文本调用需另行测试。\n");
    }
    else if (command === "doctor" || command === "chat" || command === "image") {
        let profileId = values.profile;
        if (!profileId) {
            try {
                profileId = JSON.parse(await readFile(selectedFile, "utf8")).profileId;
            }
            catch {
                throw new WebError("No CLI browser profile. Run npm run guest or npm run login first, or pass --profile", 401, "sign_in_required");
            }
        }
        if (!profileId)
            throw new WebError("Invalid CLI account marker", 401, "invalid_profile");
        if (command === "doctor") {
            const status = await bridge.call("status", { profileId }, ctl.signal);
            process.stdout.write(JSON.stringify(status, null, 2) + "\n");
        }
        else if (command === "image") {
            const prompt = values["prompt-file"] ? await readFile(values["prompt-file"], "utf8") : values.prompt ?? positionals.slice(1).join(" ");
            if (!prompt && !values["extract-last"])
                throw new WebError("Pass --prompt or --prompt-file", 400, "missing_prompt");
            const count = values.n === undefined ? 1 : Number(values.n);
            if (!Number.isSafeInteger(count) || count < 1 || count > 4)
                throw new WebError("--n must be 1–4", 400, "invalid_count");
            const extra = values["image-timeout"] === undefined ? {} : { timeoutMs: Number(values["image-timeout"]) * 1000 };
            if (values["image-timeout"] !== undefined && !Number.isFinite(extra.timeoutMs))
                throw new WebError("--image-timeout must be a number of seconds", 400, "invalid_timeout");
            const result = values["extract-last"]
                ? await bridge.latestImage(profileId, { outputDir: values.out ?? options.imageDir, ...(values.filename ? { filename: values.filename } : {}) }, ctl.signal)
                : await bridge.generateImage(profileId, {
                    prompt,
                    outputDir: values.out ?? options.imageDir,
                    model: values.model,
                    n: count,
                    ...(values.size ? { size: values.size } : {}),
                    ...(values.quality ? { quality: values.quality } : {}),
                    ...(values.filename ? { filename: values.filename } : {}),
                    ...(values["prompt-suffix"] ? { promptSuffix: values["prompt-suffix"] } : {}),
                    ...(values.reference?.length ? { references: values.reference.map(path => ({ path })) } : {}),
                    ...extra,
                }, ctl.signal);
            if (values.json)
                process.stdout.write(JSON.stringify(result, null, 2) + "\n");
            else {
                process.stderr.write(`网页模型：${result.modelLabel}｜耗时 ${(result.elapsedMs / 1000).toFixed(1)}s\n`);
                for (const image of result.images) {
                    process.stdout.write(`${image.path}\t${image.width ?? "?"}x${image.height ?? "?"}\t${image.mimeType}\t${image.bytes} bytes\t${image.via}\n`);
                }
                for (const warning of result.warnings)
                    process.stderr.write(`警告：${warning}\n`);
            }
        }
        else {
            const prompt = values["prompt-file"] ? await readFile(values["prompt-file"], "utf8") : values.prompt ?? positionals.slice(1).join(" ");
            if (!prompt)
                throw new WebError("Pass --prompt or --prompt-file", 400, "missing_prompt");
            const completion = prepare(JSON.stringify({ model: values.model, messages: [{ role: "user", content: prompt }], stream: true }), options);
            const source = await bridge.open(profileId, completion, ctl.signal);
            let done = false;
            for await (const e of source) {
                if (e.event === "ready")
                    process.stderr.write(`网页模型：${e.modelLabel}\n`);
                else if (e.event === "delta")
                    process.stdout.write(e.text);
                else if (e.event === "done") {
                    done = true;
                    break;
                }
            }
            if (!done)
                throw new WebError("The webpage response did not complete", 502, "incomplete_response");
            process.stdout.write("\n");
        }
    }
    else {
        process.stdout.write("chatgpt-web guest|login|doctor|chat|image [login --cookies /absolute/path/cookies.json | login --profile UUID] [--options file.json] [--profile UUID] [--model web-current] [--prompt text | --prompt-file path]\n"
            + "  image: [--size 1024x1024|16:9|square] [--out DIR] [--n 1-4] [--quality high] [--filename base] [--reference /abs/img.png ...] [--prompt-suffix text] [--image-timeout seconds] [--json]\n");
    }
}
catch (e) {
    process.stderr.write(`${publicError(e).message}\n`);
    process.exitCode = 1;
}
finally {
    await bridge.close();
}
