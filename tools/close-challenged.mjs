import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
const dir = process.argv[2];
const raw = (await readFile(join(dir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${raw[0]}${raw[1]}`, { timeout: 15000, noDefaults: true });
const ctx = browser.contexts()[0];
let closed = 0;
for (const p of ctx.pages()) {
  try {
    const t = await p.title();
    if (/^Just a moment/i.test(t)) { await p.close(); closed++; console.log("closed challenged tab:", p.url().slice(0, 60)); }
  } catch {}
}
console.log("closed", closed, "tab(s); remaining:", ctx.pages().length);
await browser.close();
