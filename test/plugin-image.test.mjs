import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPluginHooks, IMAGE_MODEL } from '../dist/plugin.js';
import { temporaryDirectory } from './helpers.mjs';

const PROFILE = '3f2b1a09-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const picture = Buffer.from('89504e470d0a1a0a', 'hex');

/** A runtime that answers like the browser worker without a browser. */
function stubRuntime(imageDir) {
  const calls = { images: [] };
  return {
    calls,
    async call(method) { return method === 'status' ? { authenticated: true, accountId: 'stub' } : { profileId: PROFILE }; },
    async open() {
      async function* events() { yield { event: 'ready', modelLabel: 'stub' }; yield { event: 'delta', text: '你好' }; yield { event: 'done' }; }
      return events();
    },
    async close() {},
    async generateImage(profileId, request) {
      calls.images.push({ profileId, request });
      const path = join(imageDir, `stub-${calls.images.length}.png`);
      await writeFile(path, picture);
      return {
        success: true, profileId, model: 'web-current', modelLabel: 'ChatGPT Web · 当前网页模型',
        prompt: request.prompt, requestedCount: request.n ?? 1,
        images: [{ path, filename: 'stub.png', mimeType: 'image/png', bytes: picture.length, width: 1024, height: 1024, sha256: 'x'.repeat(64), sourceUrl: 'blob:stub', via: 'page-fetch' }],
        text: '', elapsedMs: 12, warnings: [],
      };
    },
  };
}

async function hooksWith(t) {
  const temp = await temporaryDirectory();
  t.after(() => temp.close());
  const runtime = stubRuntime(temp.path);
  const hooks = createPluginHooks({ imageDir: join(temp.path, 'images') }, runtime);
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: `browser:${PROFILE}` }));
  return { hooks, runtime, temp, loader };
}

test('the provider declares the webpage image model beside the text models', async t => {
  const { hooks } = await hooksWith(t);
  const models = await hooks.provider.models();
  assert.deepEqual(Object.keys(models), ['web-current', IMAGE_MODEL]);
  assert.equal(models[IMAGE_MODEL].capabilities.output.image, true);
  assert.equal(models['web-current'].capabilities.output.image, undefined);
});

test('the OpenAI Images API is served from the webpage image tool', async t => {
  const { loader, runtime } = await hooksWith(t);
  const response = await loader.fetch('https://chatgpt-web.invalid/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: '一只猫', size: '16:9', n: 1, quality: 'high' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].mime_type, 'image/png');
  assert.equal(Buffer.from(body.data[0].b64_json, 'base64').toString('hex'), picture.toString('hex'));
  assert.deepEqual([body.data[0].width, body.data[0].height], [1024, 1024]);
  assert.match(body.data[0].local_path, /stub-1\.png$/);
  assert.equal(runtime.calls.images[0].profileId, PROFILE);
  assert.equal(runtime.calls.images[0].request.size, '16:9');
  assert.equal(runtime.calls.images[0].request.quality, 'high');
});

test('image requests are refused with a code, never silently degraded', async t => {
  const { loader } = await hooksWith(t);
  const cases = [
    [{ prompt: '' }, 'missing_prompt'],
    [{ prompt: 'x', n: 9 }, 'invalid_count'],
    [{ prompt: 'x', quality: 'ultra' }, 'unsupported_parameter'],
  ];
  for (const [body, code] of cases) {
    const response = await loader.fetch('https://chatgpt-web.invalid/v1/images/generations', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
  }
  const edits = await loader.fetch('https://chatgpt-web.invalid/v1/images/edits', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
  assert.equal(edits.status, 400);
  assert.equal((await edits.json()).error.code, 'images_edits_unsupported');
});

test('the text provider is unchanged by the image work', async t => {
  const { loader } = await hooksWith(t);
  const response = await loader.fetch('https://chatgpt-web.invalid/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'web-current', messages: [{ role: 'user', content: '你好' }], stream: false }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, '你好');
  assert.equal(body.model, 'web-current');
});

test('an unauthenticated image request says so instead of drawing', async t => {
  const temp = await temporaryDirectory();
  t.after(() => temp.close());
  const runtime = stubRuntime(temp.path);
  const hooks = createPluginHooks({ imageDir: temp.path }, runtime);
  const loader = await hooks.auth.loader(async () => ({ type: 'oauth' }));
  const response = await loader.fetch('https://chatgpt-web.invalid/v1/images/generations', { method: 'POST', body: JSON.stringify({ prompt: 'x' }) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'sign_in_required');
  assert.equal(runtime.calls.images.length, 0);
});

test('the agent tool reports the files it wrote', async t => {
  const { hooks, runtime } = await hooksWith(t);
  const definition = hooks.tool.chatgpt_web_generate_image;
  assert.match(definition.description, /webpage image tool/);
  const answer = JSON.parse(await definition.execute({ prompt: '一只猫', n: 2, size: '1:1' }, { abort: undefined }));
  assert.equal(answer.success, true);
  assert.equal(answer.images.length, 1);
  assert.match(answer.images[0].path, /stub-1\.png$/);
  assert.equal(runtime.calls.images.length, 1);
  assert.equal(runtime.calls.images[0].request.n, 2);
});
