import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocateChannelPath, clearStaleSocket, createNativeChannel, ensureIpcParams, matchesPlatform, readIpcParams,
} from '../src/ipc.mjs';
import sessionModule from '../native/session.cjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'openqq-ipc-'));

test('endpoint names are random and only reused after being persisted', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 还没有 ipc.json 时按首次注入处理。
  assert.equal(readIpcParams(dir), null);
  const first = ensureIpcParams(dir);
  assert.equal(matchesPlatform(first.pipe), true);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(dir, 'ipc.json')), true);
  // 同一份安装第二次启动复用同一个端点 —— 这是「重启 OpenQQ 不重启 QQ」的前提。
  assert.deepEqual(ensureIpcParams(dir), first);
  // 端点名不能是「由项目路径推导出来的固定值」：两次独立生成必须不同。
  assert.notEqual(allocateChannelPath().path, allocateChannelPath().path);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dir, 'ipc.json')).mode & 0o777, 0o600);
  }
});

test('a persisted endpoint for another platform is treated as a first injection', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const foreign = process.platform === 'win32' ? '/tmp/openqq-deadbeef.sock' : '\\\\.\\pipe\\openqq-deadbeef';
  writeFileSync(join(dir, 'ipc.json'), JSON.stringify({ pipe: foreign, token: 'a'.repeat(64) }));
  assert.equal(readIpcParams(dir), null);
  const fresh = ensureIpcParams(dir);
  assert.equal(matchesPlatform(fresh.pipe), true);
  assert.notEqual(fresh.pipe, foreign);
  // 令牌太短同样按无效处理，不会拿着一个弱令牌去监听。
  writeFileSync(join(dir, 'ipc.json'), JSON.stringify({ pipe: fresh.pipe, token: 'short' }));
  assert.equal(readIpcParams(dir), null);
});

test('clearStaleSocket only removes endpoints nobody is listening on', async t => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missing = join(dir, 'nothing.sock');
  assert.equal(await clearStaleSocket(missing), false);
  const regular = join(dir, 'regular.sock');
  writeFileSync(regular, '');
  assert.equal(await clearStaleSocket(regular), false);
  assert.equal(existsSync(regular), true);
  if (process.platform === 'win32') return;
  const live = join(dir, 'live.sock');
  const server = createServer();
  await new Promise(resolve => server.listen(live, resolve));
  t.after(() => server.close());
  assert.equal(await clearStaleSocket(live), false);
  assert.equal(existsSync(live), true, '正在服务的端点不能被删掉');
});

test('a leftover socket file from a crashed run is removed before listen', async t => {
  if (process.platform === 'win32') return;
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stale = join(dir, 'crashed.sock');
  // 子进程绑上就 exit(0)，不 close —— 这正是崩溃留下的那种 socket 文件。
  const child = spawnSync(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => process.exit(0))', stale], { timeout: 20000 });
  if (child.status !== 0 || !existsSync(stale)) return; // 该平台不留残file，跳过
  assert.equal(await clearStaleSocket(stale), true);
  assert.equal(existsSync(stale), false);
});

test('the endpoint can be re-authenticated after a reconnect and replays session_ready', async t => {
  const path = allocateChannelPath().path;
  const token = 'b'.repeat(64);
  const first = await createNativeChannel(path, token);
  const waitFor = (events, predicate) => new Promise(resolve => {
    const receive = event => {
      if (!predicate(event)) return;
      events.removeListener('event', receive);
      resolve(event);
    };
    events.on('event', receive);
  });
  const connected = once(first.events, 'connected');
  const prototype = Object.freeze({
    init(_config, _depends, _dispatcher, callbacks) { callbacks.onSessionInitComplete({ result: 0 }); },
    getMsgService() { return { addKernelMsgListener() { return 1; }, removeKernelMsgListener() {} }; },
  });
  const session = Object.create(prototype);
  const factory = Object.freeze({ getNTWrapperSession() { return session; } });
  const facade = sessionModule.startNative({ pipe: path, token }, Object.freeze({ NodeIQQNTWrapperSession: factory }));
  t.after(() => { globalThis.__openqq_hook?.dispose(); first.close().catch(() => {}); });
  await connected;
  const firstReady = waitFor(first.events, event => event.type === 'session_ready');
  facade.NodeIQQNTWrapperSession.getNTWrapperSession('u_self').init({ selfUin: '123456', selfUid: 'u_self' }, {}, {}, {});
  assert.equal((await firstReady).resumed, undefined);
  // 断开后 QQ 侧应当自己连回来（同一端点、同一令牌），并且重放 session_ready，
  // 否则 OpenQQ 侧拿不到 self_id，前置层会判 ready=false、动作全回 1502。
  await first.close();
  const second = await createNativeChannel(path, token);
  t.after(() => second.close());
  // 监听要在连接之前挂好：服务端认证完 hello 后会在同一个 data 回调里继续处理紧随其后的
  // session_ready，等 'connected' 再挂就会漏掉这一帧。
  const resumedEvent = waitFor(second.events, event => event.type === 'session_ready');
  await once(second.events, 'connected');
  const resumed = await resumedEvent;
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.self_id, '123456');
});
