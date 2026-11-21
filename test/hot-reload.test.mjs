import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createNativeChannel } from '../src/ipc.mjs';

const require = createRequire(import.meta.url);
const nativeDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'native');

const fixture = marker => `'use strict';
module.exports = {
  createActionHandler: () => ({
    execute: async () => ({ status: 'ok', retcode: 0, data: { marker: ${JSON.stringify(marker)} } }),
    observe() {},
    dispose() {},
  }),
};
`;

// 把 native/ 整份复制到临时目录，再把 actions.cjs 换成夹具：这样 session.cjs 的 __dirname
// 就是这个临时目录，热重载走的是和发布包完全相同的代码路径（不是为测试留的后门）。
function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openqq-hot-'));
  for (const name of readdirSync(nativeDir)) {
    if (name.endsWith('.cjs')) copyFileSync(join(nativeDir, name), join(dir, name));
  }
  writeFileSync(join(dir, 'actions.cjs'), fixture('v1'));
  return dir;
}

function fakeWrapper() {
  const prototype = Object.freeze({
    init(_config, _depends, _dispatcher, callbacks) { callbacks.onSessionInitComplete({ result: 0 }); },
    getMsgService() { return { addKernelMsgListener() { return 1; }, removeKernelMsgListener() {} }; },
  });
  const session = Object.create(prototype);
  const factory = Object.freeze({ getNTWrapperSession() { return session; } });
  return { wrapper: Object.freeze({ NodeIQQNTWrapperSession: factory }), factory };
}

test('actions.cjs is reloaded when its mtime changes, without restarting anything', async t => {
  const dir = stage();
  const channel = await createNativeChannel();
  const facadeWrapper = fakeWrapper();
  const connected = once(channel.events, 'connected');
  const sessionModule = require(join(dir, 'session.cjs'));
  const facade = sessionModule.startNative({ pipe: channel.path, token: channel.token }, facadeWrapper.wrapper);
  t.after(async () => {
    globalThis.__openqq_hook?.dispose();
    await channel.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await connected;
  const ready = new Promise(resolve => {
    const receive = event => {
      if (event.type !== 'session_ready') return;
      channel.events.removeListener('event', receive);
      resolve(event);
    };
    channel.events.on('event', receive);
  });
  facade.NodeIQQNTWrapperSession.getNTWrapperSession('u_self').init({ selfUin: '123456', selfUid: 'u_self' }, {}, {}, {});
  await ready;

  const first = await channel.request({ action: 'anything' });
  assert.equal(first.data.marker, 'v1');

  // 改内容并显式把 mtime 推后，避免同一毫秒内写入导致 mtimeMs 没变。
  const actionsPath = join(dir, 'actions.cjs');
  writeFileSync(actionsPath, fixture('v2'));
  const later = new Date(Date.now() + 5000);
  utimesSync(actionsPath, later, later);

  const second = await channel.request({ action: 'anything' });
  assert.equal(second.data.marker, 'v2', '下一次动作调用应当已经吃到新文件');

  // 文件没变时不应该反复重载（每次重载都会重建 handler，丢状态）。
  const third = await channel.request({ action: 'anything' });
  assert.equal(third.data.marker, 'v2');
});

test('a broken actions.cjs keeps the previous handler and does not break the channel', async t => {
  const dir = stage();
  const channel = await createNativeChannel();
  const facadeWrapper = fakeWrapper();
  const connected = once(channel.events, 'connected');
  const sessionModule = require(join(dir, 'session.cjs'));
  const facade = sessionModule.startNative({ pipe: channel.path, token: channel.token }, facadeWrapper.wrapper);
  t.after(async () => {
    globalThis.__openqq_hook?.dispose();
    await channel.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await connected;
  const ready = new Promise(resolve => {
    const receive = event => {
      if (event.type !== 'session_ready') return;
      channel.events.removeListener('event', receive);
      resolve(event);
    };
    channel.events.on('event', receive);
  });
  facade.NodeIQQNTWrapperSession.getNTWrapperSession('u_self').init({ selfUin: '123456', selfUid: 'u_self' }, {}, {}, {});
  await ready;
  assert.equal((await channel.request({})).data.marker, 'v1');

  const actionsPath = join(dir, 'actions.cjs');
  writeFileSync(actionsPath, 'this is not javascript {');
  const later = new Date(Date.now() + 5000);
  utimesSync(actionsPath, later, later);

  // 重载失败保留旧 handler：动作继续按旧逻辑跑，而不是整条通道坏掉。
  assert.equal((await channel.request({})).data.marker, 'v1');
});
