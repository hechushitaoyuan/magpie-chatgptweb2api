import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { BrowserRuntime } from '../dist/browser.js';
import { parseOptions } from '../dist/options.js';
import { imageSize, sizeInstruction, imagePrompt, saveImages, extensionFor } from '../dist/image.js';
import { temporaryDirectory, browserExecutable } from './helpers.mjs';

/** A real PNG of the requested size, so the reader meets the same bytes a browser would hold. */
export function png(width, height, rgb = [200, 30, 90]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const body = Buffer.concat([head.subarray(4), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table;
function crc32(buffer) {
  if (!table) {
    table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * A ChatGPT-shaped fixture that draws a picture instead of answering in text: the same
 * composer, turn containers and Send button the real page uses, with the two ways a generated
 * image reaches the DOM (a blob: URL and a signed https asset on the page's own origin).
 */
export async function imageFixture() {
  const picture = png(176, 128);
  const state = { mode: 'blob', submissions: [], assetHits: 0 };
  const server = createServer(async (req, res) => {
    if (req.url === '/api/auth/session') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.headers.cookie?.includes('fixture=1') ? { user: { id: 'fixture-account', email: 'fixture@example.invalid' } } : {}));
      return;
    }
    if (req.url === '/state') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ mode: state.mode }));
      return;
    }
    if (req.url === '/submitted') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      state.submissions.push(Buffer.concat(chunks).toString());
      res.end('ok');
      return;
    }
    if (req.url?.startsWith('/backend-api/estuary/content')) {
      state.assetHits++;
      res.setHeader('content-type', 'image/png');
      res.setHeader('cache-control', 'no-store');
      res.end(picture);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('set-cookie', 'fixture=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400');
    res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>
      <div id="messages"></div>
      <div id="prompt-textarea" contenteditable="true" style="min-height:40px;border:1px solid"></div>
      <button data-testid="send-button">Send</button><div id="controls"></div>
      <script>
        let seq = 0;
        const composer = document.querySelector('#prompt-textarea');
        const send = document.querySelector('[data-testid="send-button"]');
        const messages = document.querySelector('#messages');
        send.onclick = async () => {
          const mode = (await (await fetch('/state')).json()).mode;
          const prompt = composer.textContent;
          send.disabled = true;
          fetch('/submitted', {method:'POST', body: prompt});
          composer.textContent = '';
          const user = document.createElement('article');
          user.dataset.turnId = 'new-user-' + (++seq);
          const ub = document.createElement('div'); ub.dataset.messageAuthorRole = 'user'; ub.textContent = prompt;
          user.append(ub); messages.append(user);
          const assistant = document.createElement('article');
          assistant.dataset.turnId = 'new-assistant-' + seq;
          const body = document.createElement('div'); body.dataset.messageAuthorRole = 'assistant';
          body.innerHTML = '<div class="markdown"><p>已经生成。</p></div>';
          assistant.append(body); messages.append(assistant);
          const stop = document.createElement('button');
          stop.dataset.testid = 'stop-button'; stop.textContent = 'Stop';
          document.querySelector('#controls').append(stop);
          const finish = () => {
            stop.remove();
            const copy = document.createElement('button');
            copy.dataset.testid = 'copy-turn-action-button'; copy.textContent = 'Copy';
            assistant.append(copy);
            send.disabled = false;
          };
          if (mode === 'refuse') {
            setTimeout(() => { body.querySelector('.markdown').innerHTML = '<p>I cannot generate that image because it violates our content policy.</p>'; finish(); }, 150);
            return;
          }
          if (mode === 'nothing') { setTimeout(finish, 150); return; }
          if (mode === 'rate-limit') {
            setTimeout(() => { const a = document.createElement('div'); a.setAttribute('role','alert'); a.textContent = "You've hit the limit reached"; document.body.append(a); }, 80);
            return;
          }
          setTimeout(async () => {
            const image = document.createElement('img');
            image.alt = 'generated picture';
            image.style.width = '176px'; image.style.height = '128px';
            if (mode === 'asset') image.src = '/backend-api/estuary/content?id=file-fixture&sig=abc';
            else {
              const blob = await (await fetch('/backend-api/estuary/content?id=file-fixture&sig=blob')).blob();
              image.src = URL.createObjectURL(blob);
            }
            body.append(image);
            setTimeout(finish, 60);
          }, 120);
        };
      </script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    picture,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('size hints accept ratios, pixels and names, and reject nonsense', () => {
  assert.equal(sizeInstruction('16:9').ratio, '16:9');
  assert.match(sizeInstruction('16:9').text, /宽屏/);
  assert.equal(sizeInstruction('landscape').ratio, '16:9');
  assert.equal(sizeInstruction('square').ratio, '1:1');
  assert.equal(sizeInstruction('1024x1024').ratio, '1:1');
  assert.match(sizeInstruction('1024x768').text, /4:3/);
  assert.equal(sizeInstruction(undefined).text, '');
  assert.throws(() => sizeInstruction('huge'), e => e.code === 'invalid_size');
  assert.throws(() => sizeInstruction('9000x9000'), e => e.code === 'invalid_size');
});

test('the submitted prompt carries the image intent and the size, never the raw size string', () => {
  const rendered = imagePrompt({ prompt: '一只走在雨里的猫', size: '16:9', outputDir: '/tmp/x', n: 2 });
  assert.match(rendered.prompt, /一只走在雨里的猫/);
  assert.match(rendered.prompt, /16:9/);
  assert.match(rendered.prompt, /生成 2 张/);
  assert.match(rendered.prompt, /直接生成图片/);
  assert.throws(() => imagePrompt({ prompt: '  ', outputDir: '/tmp/x' }), e => e.code === 'missing_prompt');
});

test('picture headers decode for PNG, GIF, JPEG and WebP, and for nothing else', () => {
  const pngBytes = png(320, 200);
  assert.deepEqual(imageSize(pngBytes), { width: 320, height: 200, mimeType: 'image/png' });
  assert.equal(extensionFor('image/png'), 'png');
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('application/octet-stream', 'https://x/y.webp?sig=1'), 'webp');
  assert.equal(imageSize(Buffer.from('not a picture')), undefined);
});

test('saved files never overwrite an existing name', async t => {
  const temp = await temporaryDirectory();
  t.after(() => temp.close());
  const bytes = png(100, 100);
  const first = await saveImages(temp.path, [{ bytes, mimeType: 'image/png', url: 'blob:x', via: 'page-fetch' }], 'shot');
  const second = await saveImages(temp.path, [{ bytes, mimeType: 'image/png', url: 'blob:x', via: 'page-fetch' }], 'shot');
  assert.equal(first[0].filename, 'shot.png');
  assert.equal(second[0].filename, 'shot-1.png');
  assert.equal(first[0].sha256, second[0].sha256);
  assert.deepEqual([first[0].width, first[0].height], [100, 100]);
  assert.equal((await readdir(temp.path)).length, 2);
});

test('the webpage image tool returns a real file from a blob: URL', async t => {
  const temp = await temporaryDirectory();
  const site = await imageFixture();
  t.after(async () => { await site.close(); await temp.close(); });
  const options = parseOptions({ profilesDir: temp.path, executablePath: await browserExecutable(), headless: true, browserMode: 'managed', pollMs: 50, settleMs: 100, imageTimeoutMs: 30000, idleTimeoutMs: 1000 });
  const runtime = new BrowserRuntime(options, site.url);
  t.after(() => runtime.close());
  const { profileId } = await runtime.beginLogin();
  await runtime.waitLogin(profileId);

  const result = await runtime.generateImage(profileId, { prompt: '画一只猫', size: '4:3', outputDir: temp.path, filename: 'cat' });
  assert.equal(result.success, true);
  assert.equal(result.images.length, 1);
  const image = result.images[0];
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual([image.width, image.height], [176, 128]);
  assert.ok(['page-fetch', 'network'].includes(image.via), `unexpected source: ${image.via}`);
  assert.equal(Buffer.compare(await readFile(image.path), site.picture), 0);
  assert.match(site.state.submissions.at(-1), /画一只猫/);
  assert.match(site.state.submissions.at(-1), /4:3/);
  assert.equal(result.requestedSize, '4:3');
});

test('a signed https asset is read through the browser context', async t => {
  const temp = await temporaryDirectory();
  const site = await imageFixture();
  site.state.mode = 'asset';
  t.after(async () => { await site.close(); await temp.close(); });
  const options = parseOptions({ profilesDir: temp.path, executablePath: await browserExecutable(), headless: true, browserMode: 'managed', pollMs: 50, settleMs: 100, imageTimeoutMs: 30000, idleTimeoutMs: 1000 });
  const runtime = new BrowserRuntime(options, site.url);
  t.after(() => runtime.close());
  const { profileId } = await runtime.beginLogin();
  await runtime.waitLogin(profileId);
  const result = await runtime.generateImage(profileId, { prompt: '画一只狗', outputDir: temp.path, filename: 'dog' });
  assert.deepEqual([result.images[0].width, result.images[0].height], [176, 128]);
  assert.equal(Buffer.compare(await readFile(result.images[0].path), site.picture), 0);
});

test('a refusal and an empty answer both fail loudly instead of returning nothing', async t => {
  const temp = await temporaryDirectory();
  const site = await imageFixture();
  t.after(async () => { await site.close(); await temp.close(); });
  const options = parseOptions({ profilesDir: temp.path, executablePath: await browserExecutable(), headless: true, browserMode: 'managed', pollMs: 50, settleMs: 100, imageTimeoutMs: 6000, idleTimeoutMs: 1000 });
  const runtime = new BrowserRuntime(options, site.url);
  t.after(() => runtime.close());
  const { profileId } = await runtime.beginLogin();
  await runtime.waitLogin(profileId);

  site.state.mode = 'refuse';
  await assert.rejects(
    runtime.generateImage(profileId, { prompt: '画点不该画的', outputDir: temp.path }),
    e => e.code === 'image_refused' && /content policy/i.test(e.message),
  );

  site.state.mode = 'nothing';
  await assert.rejects(
    runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: temp.path }),
    e => e.code === 'image_not_generated' && /without an image/.test(e.message),
  );
});

test('an upstream rate limit is reported as one, not as a missing picture', async t => {
  const temp = await temporaryDirectory();
  const site = await imageFixture();
  site.state.mode = 'rate-limit';
  t.after(async () => { await site.close(); await temp.close(); });
  const options = parseOptions({ profilesDir: temp.path, executablePath: await browserExecutable(), headless: true, browserMode: 'managed', pollMs: 50, settleMs: 100, imageTimeoutMs: 6000, idleTimeoutMs: 1000 });
  const runtime = new BrowserRuntime(options, site.url);
  t.after(() => runtime.close());
  const { profileId } = await runtime.beginLogin();
  await runtime.waitLogin(profileId);
  await assert.rejects(
    runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: temp.path }),
    e => e.code === 'upstream_rate_limit' && e.status === 429,
  );
});
