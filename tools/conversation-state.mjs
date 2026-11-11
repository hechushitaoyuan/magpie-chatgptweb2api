// Evidence tool: what the account and the bound conversation hold right now. Read-only.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
const dir = process.argv[2];
const boundId = process.argv[3];
const marker = process.argv[4] ?? "STATE";
const raw = (await readFile(join(dir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${raw[0]}${raw[1]}`, { timeout: 15000, noDefaults: true });
const ctx = browser.contexts()[0];
let page = ctx.pages().find(p => p.url().includes(boundId)) ?? ctx.pages().find(p => p.url().startsWith("https://chatgpt.com"));
const state = await page.evaluate(async ({ boundId }) => {
  const session = await (await fetch("/api/auth/session", { credentials: "same-origin" })).json();
  const headers = session?.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {};
  const r = await fetch("/backend-api/conversations?offset=0&limit=28&order=updated", { credentials: "same-origin", headers });
  const j = r.ok ? await r.json() : { items: [], total: null };
  const items = (j.items ?? []).map(c => ({ id: c.id, title: c.title, updated: c.update_time }));
  const boundTurns = document.querySelectorAll("[data-turn-key], [data-turn-id]").length;
  const userBubbles = [...document.querySelectorAll("[data-turn-key]")].filter(g => g.querySelector("[data-user-message-bubble]")).length;
  const lastUser = [...document.querySelectorAll("[data-user-message-bubble]")].at(-1)?.textContent?.replace(/\s+/g, " ").slice(0, 120) ?? null;
  const attachments = [...document.querySelectorAll("img")].filter(i => (i.getAttribute("alt") || "") === "User attachment").length;
  return {
    pageUrl: location.pathname, pageTitle: document.title,
    accountTotalConversations: j.total ?? null, listedNow: items.length,
    newestConversations: items.slice(0, 4),
    dedicatedTitled: items.filter(c => (c.title || "").trim() === "ari项目专用生图会话").map(c => c.id),
    boundTurnContainers: boundTurns, userTurns: userBubbles, lastUserMessage: lastUser, userAttachments: attachments,
  };
}, { boundId });
console.log(JSON.stringify({ marker, ...state }, null, 1));
await browser.close();
