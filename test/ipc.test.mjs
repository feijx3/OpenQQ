import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { createNativeChannel } from '../src/ipc.mjs';
import sessionModule from '../native/session.cjs';
import { createEventConverter } from '../src/onebot.mjs';

test('native channel authenticates and decodes split UTF-8 event frames', async t => {
  const channel = await createNativeChannel();
  t.after(() => channel.close());
  const socket = createConnection(channel.path);
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const connected = once(channel.events, 'connected');
  socket.write(JSON.stringify({ type: 'hello', token: channel.token, pid: 42 }) + '\n');
  assert.deepEqual(await connected, [{ pid: 42 }]);
  const received = once(channel.events, 'event');
  const frame = Buffer.from(JSON.stringify({ type: 'fixture', text: '中文' }) + '\n');
  const split = frame.indexOf(Buffer.from('中')) + 1;
  socket.write(frame.subarray(0, split));
  socket.write(frame.subarray(split));
  assert.deepEqual(await received, [{ type: 'fixture', text: '中文' }]);
});

test('native channel rejects invalid authentication without delivering an event', async t => {
  const channel = await createNativeChannel();
  t.after(() => channel.close());
  let accepted = false;
  channel.events.on('connected', () => { accepted = true; });
  const socket = createConnection(channel.path);
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  socket.write(JSON.stringify({ type: 'hello', token: 'wrong', pid: 42 }) + '\n');
  await closed;
  assert.equal(accepted, false);
});

test('native channel closes oversized unauthenticated frames', async t => {
  const channel = await createNativeChannel();
  t.after(() => channel.close());
  const socket = createConnection(channel.path);
  socket.on('error', () => {});
  await once(socket, 'connect');
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write('x'.repeat(1024 * 1024 + 1));
  await closed;
});

test('native payload connects without Inspector, keeps the hook across a reconnect and restores methods on dispose', async t => {
  const channel = await createNativeChannel();
  t.after(() => channel.close());
  const session = { init() {} };
  const originalInit = session.init;
  const original = () => session;
  const factory = { create: original };
  const connected = once(channel.events, 'connected');
  const wrapper = once(channel.events, 'event');
  const facade = sessionModule.startNative({ pipe: channel.path, token: channel.token }, Object.freeze({ NodeIQQNTWrapperSession: Object.freeze(factory) }));
  t.after(() => globalThis.__openqq_hook?.dispose());
  assert.equal((await connected)[0].pid, process.pid);
  assert.equal((await wrapper)[0].type, 'wrapper_loaded');
  assert.notEqual(facade.NodeIQQNTWrapperSession.create, original);
  assert.equal(factory.create, original);
  facade.NodeIQQNTWrapperSession.create();
  assert.notEqual(session.init, originalInit);
  // 固定端点意味着 IPC 断开后 QQ 侧会重连，所以包装保持原位 —— 这正是"重启 OpenQQ 不用重启 QQ"的前提。
  await channel.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.notEqual(facade.NodeIQQNTWrapperSession.create, original);
  assert.notEqual(session.init, originalInit);
  assert.equal(globalThis.__openqq_hook !== undefined, true);
  // 只有显式 dispose 才把包装撤掉并还原原始方法。
  globalThis.__openqq_hook?.dispose();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(factory.create, original);
  assert.equal(session.init, originalInit);
  assert.equal(globalThis.__openqq_hook, undefined);
});

test('read-only exports deliver text and poke events through initialization, IPC and OneBot conversion', async t => {
  const channel = await createNativeChannel();
  t.after(() => channel.close());
  let listener;
  const service = {
    addKernelMsgListener(value) { listener = value; return 'test-listener'; },
    removeKernelMsgListener(id) { assert.equal(id, 'test-listener'); },
  };
  const prototype = Object.freeze({
    init(_config, _depends, _dispatcher, callbacks) {
      assert.equal(this, session);
      callbacks.onSessionInitComplete({ result: 0 });
    },
    getMsgService() { assert.equal(this, session); return service; },
    getUixConvertService() { return { getUin: async uids => ({ uinInfo: new Map(uids.map(uid => [uid, '654321'])) }) }; },
  });
  const session = Object.create(prototype);
  const factory = Object.freeze({ getNTWrapperSession() { assert.equal(this, factory); return session; } });
  const waitFor = type => new Promise(resolve => {
    const receive = event => {
      if (event.type !== type) return;
      channel.events.removeListener('event', receive);
      resolve(event);
    };
    channel.events.on('event', receive);
  });
  const wrapperLoaded = waitFor('wrapper_loaded');
  const facade = sessionModule.startNative({ pipe: channel.path, token: channel.token }, Object.freeze({ NodeIQQNTWrapperSession: factory }));
  t.after(() => globalThis.__openqq_hook?.dispose());
  await wrapperLoaded;
  const ready = waitFor('session_ready');
  facade.NodeIQQNTWrapperSession.getNTWrapperSession('u_self').init({ selfUin: '123456', selfUid: 'u_self' }, {}, {}, {});
  assert.equal((await ready).self_id, '123456');
  const message = waitFor('message');
  listener.onRecvMsg([{
    chatType: 1, msgId: '9007199254740993', peerUid: 'u_sender', peerUin: '654321',
    senderUin: '654321', msgTime: '1794470400',
    elements: [{ elementType: 1, textElement: { content: 'q', atType: 0 } }],
  }]);
  const raw = await message;
  const convert = createEventConverter();
  const event = convert(raw);
  assert.equal(event.post_type, 'message');
  assert.equal(event.message[0].data.text, 'q');
  assert.equal(event.self_id, 123456);
  assert.equal(event.user_id, 654321);
  assert.equal(factory.getNTWrapperSession().init === prototype.init, false);
  const poke = waitFor('message');
  listener.onRecvMsg([{
    chatType: 2, msgId: '9007199254740994', peerUid: '987654', peerUin: '987654', senderUin: '0', msgTime: '1794470400',
    elements: [{ elementType: 8, grayTipElement: { jsonGrayTipElement: { busiId: '1061',
      jsonStr: JSON.stringify({ items: [{ uid: 'u_sender' }, { txt: '戳了戳' }, { uid: 'u_self' }] }),
    } } }],
  }]);
  assert.deepEqual(convert(await poke), { time: 1794470400, self_id: 123456, post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    user_id: 654321, target_id: 123456, group_id: 987654 });
  const gray = waitFor('notice');
  listener.onRecvMsg([{
    chatType: 2, msgId: '9007199254740995', peerUid: '987654', peerUin: '987654', senderUin: '0', msgTime: '1794470400',
    elements: [{ elementType: 8, grayTipElement: { subElementType: 123, nativeMap: new Map([['item', 7n]]) } }],
  }]);
  const unknown = convert(await gray);
  assert.equal(unknown.notice_type, 'openqq_gray_tip');
  assert.deepEqual(unknown.element.nativeMap, { item: '7' });
});
