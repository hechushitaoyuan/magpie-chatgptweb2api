import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserRuntime } from '../dist/browser.js';
import { parseOptions } from '../dist/options.js';
import { temporaryDirectory, browserExecutable, png } from './helpers.mjs';

const TITLE = 'ari项目专用生图会话';
const OTHER = '普通聊天会话';
const DEDICATED = '6af180fa-16d4-83e8-b4a3-650f20808876';
const PLAIN = '6af09774-0e5c-83e8-b151-8f4aec7815a4';

/**
 * A ChatGPT-shaped fixture with a home route, conversation routes and a sidebar. It records which
 * route every page load and every send happened on, so a test can prove that image generation
 * reused the bound conversation and never opened a new chat.
 */
export async function sessionFixture() {
  const picture = png(176, 128);
  const state = {
    loads: {},
    sends: [],
    /** What the sidebar and the account's conversation list show. */
    conversations: [
      { id: DEDICATED, title: TITLE },
      { id: PLAIN, title: OTHER },
    ],
    /** Off: the sidebar is empty and only the account's own list knows the conversation. */
    sidebar: true,
    challenge: false,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/auth/session') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.headers.cookie?.includes('fixture=1') ? { user: { id: 'fixture-account', email: 'fixture@example.invalid' }, accessToken: 'FIXTURE_TOKEN' } : {}));
      return;
    }
    if (url.pathname === '/backend-api/conversations') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: offset === 0 ? state.conversations.map(c => ({ id: c.id, title: c.title })) : [], total: state.conversations.length, limit: 28, offset }));
      return;
    }
    if (url.pathname === '/backend-api/estuary/content') {
      res.setHeader('content-type', 'image/png');
      res.end(picture);
      return;
    }
    if (url.pathname === '/submitted') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      state.sends.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end('ok');
      return;
    }
    state.loads[url.pathname] = (state.loads[url.pathname] ?? 0) + 1;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('set-cookie', 'fixture=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400');
    if (state.challenge) {
      res.statusCode = 403;
      res.end('<!doctype html><html><head><title>Just a moment...</title></head><body></body></html>');
      return;
    }
    const sidebar = state.sidebar
      ? state.conversations.map(c => `<a href="/c/${c.id}">${c.title}</a>`).join('')
      : '';
    res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body>
      <nav id="sidebar">${sidebar}</nav>
      <div id="messages"></div>
      <div id="prompt-textarea" contenteditable="true" style="min-height:40px;border:1px solid"></div>
      <button data-testid="send-button">Send</button>
      <script>
        const composer = document.querySelector('#prompt-textarea');
        const send = document.querySelector('[data-testid="send-button"]');
        const messages = document.querySelector('#messages');
        send.onclick = async () => {
          const prompt = composer.textContent;
          send.disabled = true;
          fetch('/submitted', {method:'POST', body: JSON.stringify({path: location.pathname, prompt})});
          composer.textContent = '';
          const user = document.createElement('article');
          user.dataset.turnId = 'new-user-' + messages.children.length;
          const ub = document.createElement('div'); ub.dataset.messageAuthorRole = 'user'; ub.textContent = prompt;
          user.append(ub); messages.append(user);
          const assistant = document.createElement('article');
          assistant.dataset.turnId = 'new-assistant-' + messages.children.length;
          const body = document.createElement('div'); body.dataset.messageAuthorRole = 'assistant';
          body.innerHTML = '<div class="markdown"><p>已经生成。</p></div>';
          assistant.append(body); messages.append(assistant);
          const stop = document.createElement('button');
          stop.dataset.testid = 'stop-button'; stop.textContent = 'Stop';
          document.body.append(stop);
          const blob = await (await fetch('/backend-api/estuary/content?id=file-fixture')).blob();
          const image = document.createElement('img');
          image.alt = 'generated'; image.style.width = '176px'; image.style.height = '128px';
          image.src = URL.createObjectURL(blob);
          body.append(image);
          setTimeout(() => {
            stop.remove();
            const copy = document.createElement('button');
            copy.dataset.testid = 'copy-turn-action-button'; copy.textContent = 'Copy';
            assistant.append(copy);
            send.disabled = false;
          }, 80);
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

async function runtimeFor(t, site, extra = {}) {
  const temp = await temporaryDirectory();
  t.after(async () => { await site.close(); await temp.close(); });
  const options = parseOptions({
    profilesDir: temp.path,
    imageDir: join(temp.path, 'images'),
    executablePath: await browserExecutable(),
    headless: true,
    browserMode: 'managed',
    pollMs: 50,
    settleMs: 100,
    imageTimeoutMs: 20000,
    idleTimeoutMs: 1000,
    ...extra,
  });
  const runtime = new BrowserRuntime(options, site.url);
  t.after(() => runtime.close());
  const { profileId } = await runtime.beginLogin();
  await runtime.waitLogin(profileId);
  return { runtime, options, temp, profileId };
}

test('an image request with no binding refuses instead of opening a new chat', async t => {
  const site = await sessionFixture();
  const { runtime, profileId } = await runtimeFor(t, site, { imageConversationTitle: '' });
  await assert.rejects(
    runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: '/tmp/unused' }),
    e => e.code === 'image_conversation_unbound',
  );
  assert.deepEqual(site.state.sends, [], 'nothing may be sent when there is no bound conversation');
});

test('the title is resolved once, written down, and the conversation is reused', async t => {
  const site = await sessionFixture();
  const { runtime, options, profileId } = await runtimeFor(t, site, { imageConversationTitle: TITLE });

  const first = await runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: options.imageDir, filename: 'first' });
  assert.equal(first.success, true);
  assert.equal(site.state.sends.length, 1);
  assert.equal(site.state.sends[0].path, `/c/${DEDICATED}`, 'the send must happen inside the bound conversation');
  assert.equal(site.state.loads['/'], 1, 'the home route is only opened to look the title up');
  assert.equal(site.state.loads[`/c/${DEDICATED}`], 1, 'the bound conversation is opened once');

  const saved = JSON.parse(await readFile(options.imageSessionFile, 'utf8'));
  assert.equal(saved.id, DEDICATED);
  assert.equal(saved.title, TITLE);
  assert.equal(saved.source, 'title');

  const second = await runtime.generateImage(profileId, { prompt: '再画一只', outputDir: options.imageDir, filename: 'second' });
  assert.equal(second.success, true);
  assert.equal(site.state.sends.length, 2);
  assert.equal(site.state.sends[1].path, `/c/${DEDICATED}`);
  assert.equal(site.state.loads[`/c/${DEDICATED}`], 1, 'the hot tab is reused, not reloaded');
  assert.equal(site.state.loads['/'], 1, 'no further lookup, so no further home visit');
  assert.ok(!( '/c/' in site.state.loads), 'no other conversation route is ever loaded');
});

test('the binding survives a restart and needs no lookup then', async t => {
  const site = await sessionFixture();
  const { runtime, options, profileId } = await runtimeFor(t, site, { imageConversationTitle: TITLE });
  await runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: options.imageDir, filename: 'first' });
  await runtime.close();

  // A second runtime over the same profile directory, with the sidebar gone: the recalled id must
  // be enough, so image generation never falls back to a lookup or a new chat.
  site.state.sidebar = false;
  site.state.loads = {};
  const second = new BrowserRuntime(options, site.url);
  t.after(() => second.close());
  const status = await second.imageSessionStatus();
  assert.equal(status.bound, true);
  assert.equal(status.id, DEDICATED);
  const result = await second.generateImage(profileId, { prompt: '重启后再画', outputDir: options.imageDir, filename: 'after-restart' });
  assert.equal(result.success, true);
  assert.equal(site.state.sends.at(-1).path, `/c/${DEDICATED}`);
  assert.equal(site.state.loads[`/c/${DEDICATED}`] ?? 0, 1);
});

test('the sidebar may be stale: the account conversation list is the fallback', async t => {
  const site = await sessionFixture();
  site.state.sidebar = false;
  const { runtime, options, profileId } = await runtimeFor(t, site, { imageConversationTitle: TITLE });
  const result = await runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: options.imageDir, filename: 'list' });
  assert.equal(result.success, true);
  assert.equal(site.state.sends.at(-1).path, `/c/${DEDICATED}`);
});

test('an unknown title fails loudly and nothing is ever created', async t => {
  const site = await sessionFixture();
  const { runtime, profileId } = await runtimeFor(t, site, { imageConversationTitle: '不存在的会话' });
  await assert.rejects(
    runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: '/tmp/unused' }),
    e => e.code === 'image_conversation_not_found',
  );
  assert.deepEqual(site.state.sends, []);
  assert.equal(Object.keys(site.state.loads).filter(p => p.startsWith('/c/')).length, 0, 'no conversation route may be opened');
});

test('an explicit id binds without any lookup, and binds what the operator asked for', async t => {
  const site = await sessionFixture();
  const { runtime, options, profileId } = await runtimeFor(t, site, { imageConversationTitle: TITLE });
  site.state.conversations = [{ id: DEDICATED, title: TITLE }, { id: PLAIN, title: OTHER }];

  const homeBefore = site.state.loads['/'] ?? 0;
  const bound = await runtime.bindImageSession(profileId, `https://chatgpt.com/c/${PLAIN}`);
  assert.equal(bound.id, PLAIN);
  assert.equal(bound.source, 'url');
  const saved = JSON.parse(await readFile(options.imageSessionFile, 'utf8'));
  assert.equal(saved.id, PLAIN);

  const result = await runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: options.imageDir, filename: 'plain' });
  assert.equal(result.success, true);
  assert.equal(site.state.sends.at(-1).path, `/c/${PLAIN}`);
  assert.equal(site.state.loads['/'] ?? 0, homeBefore, 'an explicit binding needs no home visit');

  const byId = await runtime.bindImageSession(profileId, DEDICATED);
  assert.equal(byId.id, DEDICATED);
  assert.equal(byId.source, 'explicit');
});

test('a binding cannot point outside chatgpt.com, and status is readable without a browser', async t => {
  const site = await sessionFixture();
  const { runtime, options, profileId } = await runtimeFor(t, site, { imageConversationTitle: TITLE });
  await assert.rejects(
    runtime.bindImageSession(profileId, 'https://example.invalid/c/6af180fa-16d4-83e8-b4a3-650f20808876'),
    e => e.code === 'invalid_conversation',
  );
  const before = await runtime.imageSessionStatus();
  assert.equal(before.bound, false);
  assert.equal(before.configured.title, TITLE);
  assert.equal(before.configured.allowNewChat, false);
});

test('a challenged tab is refused, never sent into, and says what to do', async t => {
  const site = await sessionFixture();
  const { runtime, options, profileId } = await runtimeFor(t, site, { imageConversationTitle: TITLE });
  await writeFile(options.imageSessionFile, JSON.stringify({ version: 1, id: DEDICATED, title: TITLE, url: `${site.url}/c/${DEDICATED}`, resolvedAt: new Date().toISOString(), source: 'title' }));
  site.state.challenge = true;
  await assert.rejects(
    runtime.generateImage(profileId, { prompt: '画一只猫', outputDir: options.imageDir }),
    e => e.code === 'browser_verification_required' && /browser check/.test(e.message),
  );
  assert.deepEqual(site.state.sends, []);
});
