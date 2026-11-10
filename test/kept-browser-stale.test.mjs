/**
 * 崩溃残留的 Chrome 锁不该把生图请求挡成 409。
 *
 * 背景（2026-11-10 实报）：Chrome 被强杀后 profile 目录里留下 `SingletonLock`（host-<pid> 符号
 * 链接）和指向死端口的 `DevToolsActivePort`，插件判定"这个 profile 已被打开但没有插件连接"，
 * 直接 409，网页生图 3 分钟后超时。这里锁住两条判断：只有"锁的属主进程确实不在了"才算残留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { lockOwnerGone, clearStaleBrowserState } from '../dist/kept-browser.js';
import { temporaryDirectory } from './helpers.mjs';

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

test('a lock whose owner process is gone counts as debris', async t => {
  const temp = await temporaryDirectory();
  t.after(() => temp.close());
  const dir = join(temp.path, 'profile');
  await mkdir(dir, { recursive: true });
  // 一个几乎不可能存在的 pid（远大于 pid_max 的常见取值，且 ESRCH 语义明确）
  await symlink('arm-999999', join(dir, 'SingletonLock'));
  await writeFile(join(dir, 'DevToolsActivePort'), '1\n/devtools/browser/dead\n');
  assert.equal(await lockOwnerGone(dir), true);
  await clearStaleBrowserState(dir);
  assert.equal(await exists(join(dir, 'SingletonLock')), false);
  assert.equal(await exists(join(dir, 'DevToolsActivePort')), false);
});

test('a lock held by a live process is never treated as debris', async t => {
  const temp = await temporaryDirectory();
  t.after(() => temp.close());
  const dir = join(temp.path, 'profile');
  await mkdir(dir, { recursive: true });
  await symlink(`arm-${process.pid}`, join(dir, 'SingletonLock'));
  assert.equal(await lockOwnerGone(dir), false);
});

test('no lock means nothing to clean', async t => {
  const temp = await temporaryDirectory();
  t.after(() => temp.close());
  const dir = join(temp.path, 'profile');
  await mkdir(dir, { recursive: true });
  assert.equal(await lockOwnerGone(dir), false);
});
