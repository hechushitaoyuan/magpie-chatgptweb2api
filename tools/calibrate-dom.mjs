// Read-only: opens the bound conversation in the plugin browser and reports what the real DOM
// actually offers, so the plugin's selectors can be checked against it. Nothing is typed or sent.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
const dir = process.argv[2];
const url = process.argv[3];
const raw = (await readFile(join(dir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${raw[0]}${raw[1]}`, { timeout: 15000, noDefaults: true });
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().startsWith(url));
const adopted = Boolean(page);
if (!page) { page = await ctx.newPage(); await page.goto(url, { waitUntil: "domcontentloaded" }); }
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(3000);
  const ready = await page.evaluate(() => {
    const t = document.querySelector("textarea, [contenteditable]");
    const turns = document.querySelectorAll("[data-turn-id], [data-turn-key], [data-message-author-role], [data-testid^=\"conversation-turn\"]").length;
    return { composer: Boolean(t), turns, text: (document.body.innerText || "").length };
  });
  console.log(`wait t=${(i + 1) * 3}s composer=${ready.composer} turns=${ready.turns} textLen=${ready.text}`);
  if (ready.composer && ready.turns > 0) break;
}
await page.waitForTimeout(3000);
console.log("adopted existing tab:", adopted);
console.log("url:", page.url());
console.log("title:", JSON.stringify(await page.title()));
const out = await page.evaluate(() => {
  const sel = (s) => document.querySelectorAll(s).length;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    testid: el.getAttribute("data-testid") || undefined,
    role: el.getAttribute("role") || undefined,
    ce: el.getAttribute("contenteditable") ?? undefined,
    lexical: el.getAttribute("data-lexical-editor") ?? undefined,
    cls: (el.className || "").toString().slice(0, 80),
    placeholder: el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || undefined,
    aria: (el.getAttribute("aria-label") || "").slice(0, 40) || undefined,
  });
  const editables = [...document.querySelectorAll('[contenteditable], textarea, [role="textbox"]')].slice(0, 12).map(describe);
  const buttons = [...document.querySelectorAll("button")].filter(visible).slice(0, 25).map(b => ({
    testid: b.getAttribute("data-testid") || undefined,
    aria: (b.getAttribute("aria-label") || "").slice(0, 30) || undefined,
    text: (b.textContent || "").trim().slice(0, 20),
    disabled: b.disabled,
  }));
  return {
    counts: {
      testidPrompt: sel('[data-testid="prompt-textarea"]'),
      idPrompt: sel("#prompt-textarea"),
      lexical: sel('[contenteditable="true"][data-lexical-editor="true"]'),
      roleTextbox: sel('[contenteditable="true"][role="textbox"]'),
      anyContenteditable: sel("[contenteditable]"),
      textarea: sel("textarea"),
      prosaic: sel('[data-testid="composer-text-input"]'),
      composerForm: sel("form"),
      sendTestid: sel('[data-testid="send-button"]'),
      composerSubmit: sel("[data-composer-submit]"),
      stopTestid: sel('[data-testid="stop-button"]'),
      turnId: sel("[data-turn-id]"),
      turnIdContainer: sel("[data-turn-id-container]"),
      turnKey: sel("[data-turn-key]"),
      authorRole: sel("[data-message-author-role]"),
      conversationRole: sel('[data-conversation-role="assistant"]'),
      markdown: sel(".markdown"),
      assistantMd: sel('[data-markdown-text-style="assistant-message"]'),
      transcriptLi: sel('[data-conversation-transcript] li[id]'),
      images: sel("img"),
      fileInput: sel('input[type="file"]'),
      testidConvTurn: sel('[data-testid^="conversation-turn"]'),
      article: sel("article"),
      mainInner: (document.querySelector("main")?.innerText || "").length,
      talkToChatgpt: sel('[data-testid="composer-text-input"]'),
      lexEditor: sel('[data-lexical-editor]'),
    },
    editables,
    buttons,
    sampleTurn: (() => {
      const el = document.querySelector("[data-turn-id], [data-turn-key], article, [data-testid^=\"conversation-turn\"]");
      if (!el) return null;
      return { tag: el.tagName.toLowerCase(), attrs: [...el.attributes].map(a => `${a.name}=${String(a.value).slice(0, 40)}`).slice(0, 10), head: (el.textContent || "").replace(/\s+/g, " ").slice(0, 150) };
    })(),
    textareaAttrs: (() => { const t = document.querySelector("textarea"); return t ? [...t.attributes].map(a => `${a.name}=${String(a.value).slice(0, 60)}`) : null; })(),
    bigImages: [...document.querySelectorAll("img")].filter(i => i.naturalWidth > 96).map(i => ({
      src: (i.currentSrc || i.src || "").slice(0, 70), w: i.naturalWidth, h: i.naturalHeight, alt: (i.getAttribute("alt") || "").slice(0, 30),
    })).slice(0, 8),
  };
});
console.log(JSON.stringify(out, null, 1));
await page.screenshot({ path: "/tmp/bound-conversation.png" });
await browser.close();
