#!/usr/bin/env node
/**
 * The smallest caller a local project (ARI included) needs: ask the Magpie gateway for a picture
 * through the ChatGPT Web provider and write the bytes to a file.
 *
 *   node examples/ari-image.mjs --prompt "一只戴帽子的猫" --out /tmp/cat.png
 *
 * Environment, or the matching flags:
 *   MAGPIE_GATEWAY   http://magpie:3425          (inside ARI's compose network)
 *                    http://100.113.72.8:3425    (from a tailnet host)
 *   MAGPIE_KEY       the caller key whose allow-list names chatgpt-web/web-image
 *   MAGPIE_IMAGE_MODEL  chatgpt-web/web-image
 *
 * Nothing here touches an OpenAI API key, the OpenAI Images API or Codex: the gateway request is
 * served by the ChatGPT Web plugin, which drives the account's own logged-in webpage.
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  prompt: { type: "string" },
  out: { type: "string" },
  size: { type: "string" },
  gateway: { type: "string" },
  key: { type: "string" },
  model: { type: "string" },
} });

const prompt = values.prompt;
if (!prompt) {
  process.stderr.write("usage: ari-image.mjs --prompt \"…\" [--out file.png] [--size 1024x1024] [--gateway URL] [--key KEY] [--model id]\n");
  process.exit(2);
}
const gateway = (values.gateway ?? process.env.MAGPIE_GATEWAY ?? "http://127.0.0.1:3425").replace(/\/+$/, "");
const key = values.key ?? process.env.MAGPIE_KEY ?? "";
const model = values.model ?? process.env.MAGPIE_IMAGE_MODEL ?? "chatgpt-web/web-image";
const out = values.out ?? `chatgpt-web-${Date.now()}.png`;

const response = await fetch(`${gateway}/v1/images/generations`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({ model, prompt, n: 1, ...(values.size ? { size: values.size } : {}) }),
  signal: AbortSignal.timeout(600_000),
});
const body = await response.json().catch(() => undefined);
if (!response.ok || !body?.data?.length) {
  process.stderr.write(`gateway refused: HTTP ${response.status} ${JSON.stringify(body)?.slice(0, 500)}\n`);
  process.exit(1);
}
const first = body.data[0];
const bytes = Buffer.from(first.b64_json, "base64");
await writeFile(out, bytes);
process.stdout.write(JSON.stringify({
  ok: true, path: out, bytes: bytes.length,
  mime_type: first.mime_type ?? "image/png",
  width: first.width ?? null, height: first.height ?? null,
  model: body.model ?? model,
}) + "\n");
