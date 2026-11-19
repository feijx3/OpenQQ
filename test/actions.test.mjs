import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Readable } from 'node:stream';
import nativeActions from '../native/actions.cjs';
import nativeEvents from '../native/events.cjs';
import sessionModule from '../native/session.cjs';
import { createEventConverter } from '../src/onebot.mjs';
import { createNativeChannel } from '../src/ipc.mjs';
import { dispatchAction, redactActionRequest, redactActionResponse } from '../src/actions.mjs';
import { parseInput, startCommandInput } from '../src/input.mjs';
import { startNativeFixture } from './native-support.mjs';

const self = { uin: '123456', uid: 'u_self' };
const send = (params = {}) => ({ action: 'send_private_msg', params: { user_id: '654321', message: 'hello', ...params } });
function fixture(t, overrides = {}) {
  let serial = 9007199254740993n;
  const sends = [];
  const inputs = [];
  const service = {
    generateMsgUniqueId(type, time) { assert.ok([1, 2].includes(type)); assert.equal(time, '1794470400'); return String(serial++); },
    async sendMsg(id, peer, elements, options) { sends.push({ id, peer, elements, options }); return { result: 0 }; },
    async sendShowInputStatusReq(...args) { inputs.push(args); return { result: 0 }; },
    ...overrides.service,
  };
  const session = { getMsgService: () => service, getMSFService: () => ({ getServerTime: () => '1794470400' }),
    getUixConvertService: () => ({ getUid: async uins => ({ uidInfo: new Map(uins.map(uin => [uin, 'u_target'])) }) }),
    ...overrides.session,
  };
  const handler = nativeActions.createActionHandler(session, self, () => true);
  t.after(() => handler.dispose());
  const ack = (index = sends.length - 1, extra = {}) => ({ ...sends[index].peer, msgId: '9007199254741999', senderUin: self.uin, sendStatus: 2, ...extra });
  return { sends, inputs, handler, ack };
}

test('action validation rejects invalid IDs, unsupported segments, CQ parsing and ambiguous targets before sending', async t => {
  const f = fixture(t);
  for (const request of [null, send({ user_id: 'u_uid' }), send({ user_id: Number.MAX_SAFE_INTEGER + 1 }), send({ message: '' }),
    send({ message: 'x'.repeat(65537) }), send({ message: '[CQ:at,qq=all]' }), send({ message: [{ type: 'image', data: { file: 'a.png' } }] }),
    { action: 'delete_msg' }, { action: 'send_msg', params: { user_id: 1, group_id: 2, message: 'x' } },
    { action: 'set_input_status', params: { user_id: 123456, event_type: -1 } },
  ]) await assert.rejects(f.handler.execute(request));
  assert.equal(f.sends.length, 0);
  assert.deepEqual(nativeActions.validateAction(send({ message: '[CQ:at,qq=all]', auto_escape: true })).texts, ['[CQ:at,qq=all]']);
});

test('private send resolves UID and waits for a matching successful update rather than native acceptance', async t => {
  const f = fixture(t);
  const pending = f.handler.execute(send());
  let finished = false;
  pending.then(() => { finished = true; });
  await setImmediate();
  assert.equal(f.sends[0].peer.peerUid, 'u_target');
  assert.equal(f.sends[0].id, '0');
  assert.ok(f.sends[0].options instanceof Map);
  assert.equal(f.sends[0].elements[0].textElement.content, 'hello');
  assert.equal(finished, false);
  f.handler.observe('onMsgInfoListUpdate', [[f.ack(0, { senderUin: '999999' }), f.ack(0, { peerUid: 'u_wrong' }), f.ack(0, { sendStatus: 1 })]]);
  await setImmediate();
  assert.equal(finished, false);
  f.handler.observe('onMsgInfoListUpdate', [[f.ack()]]);
  assert.deepEqual(await pending, { self, message: { chatType: 1, peerUid: 'u_target', msgId: '9007199254741999' } });
});

test('group sends bypass UID lookup, correlate concurrent receipts and accept a receipt preceding native completion', async t => {
  const f = fixture(t, { session: { getUixConvertService() { assert.fail('group must not resolve UID'); } } });
  const first = f.handler.execute({ action: 'send_group_msg', params: { group_id: '987654', message: [{ type: 'text', data: { text: 'a' } }] } });
  const second = f.handler.execute({ action: 'send_msg', params: { group_id: '456789', message: 'b' } });
  assert.equal(f.sends.length, 2);
  f.handler.observe('onMsgInfoListUpdate', [[f.ack(1, { msgId: '2222222222222222222' }), f.ack(0, { msgId: '1111111111111111111' })]]);
  assert.equal((await first).message.msgId, '1111111111111111111');
  assert.equal((await second).message.msgId, '2222222222222222222');
});

test('private send falls back to the group service for non-friends, even when the profile store throws', async t => {
  const f = fixture(t, { session: { getUixConvertService: () => ({ getUid: async () => ({ uidInfo: new Map() }) }),
    getProfileService: () => ({ getUidByUin: () => { throw new Error('not a friend'); } }),
    getGroupService: () => ({ getUidByUins: async uins => ({ uids: new Map(uins.map(uin => [uin, 'u_member'])) }) }) } });
  const pending = f.handler.execute(send());
  await setImmediate();
  assert.equal(f.sends[0].peer.peerUid, 'u_member');
  f.handler.observe('onMsgInfoListUpdate', [[f.ack()]]);
  assert.equal((await pending).message.peerUid, 'u_member');
});

test('native rejection and failed send receipts return failure without a retry', async t => {
  const f = fixture(t);
  const pending = f.handler.execute(send());
  await setImmediate();
  f.handler.observe('onMsgInfoListUpdate', [[f.ack(0, { sendStatus: 0 })]]);
  await assert.rejects(pending, /发送失败/);
  assert.equal(f.sends.length, 1);
  const rejected = fixture(t, { service: { sendMsg: async () => ({ result: 5, errMsg: 'denied' }) } });
  await assert.rejects(rejected.handler.execute(send()), /未接受发送/);
});

test('UID conversion failure and timeout never submit a late send', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve;
  const f = fixture(t, { session: { getUixConvertService: () => ({ getUid: () => new Promise(done => { resolve = done; }) }) } });
  const pending = f.handler.execute(send());
  const failed = assert.rejects(pending, /超时.*未确认/);
  t.mock.timers.tick(15000);
  await failed;
  resolve({ uidInfo: new Map([['654321', 'u_target']]) });
  await setImmediate();
  assert.equal(f.sends.length, 0);
  const missing = fixture(t, { session: { getUixConvertService: () => ({ getUid: async () => ({ uidInfo: new Map() }) }),
    getProfileService: () => ({ getUidByUin: () => new Map() }) } });
  await assert.rejects(missing.handler.execute(send()), /无法.*UID/);
  assert.equal(missing.sends.length, 0);
});

test('send timeout reports uncertainty once and disposal cancels pending operations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const pending = f.handler.execute(send());
  await setImmediate();
  const failure = assert.rejects(pending, error => error.retcode === 1501 && error.message.includes('勿自动重试'));
  t.mock.timers.tick(15000);
  await failure;
  f.handler.observe('onMsgInfoListUpdate', [[f.ack()]]);
  assert.equal(f.sends.length, 1);
  const second = f.handler.execute(send());
  const cancelled = assert.rejects(second, error => error.retcode === 1502);
  f.handler.dispose();
  await cancelled;
  await setImmediate();
  assert.equal(f.sends.length, 1);
});

test('typing status and basic queries use the initialized session', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.handler.execute({ action: 'get_login_info' }), { user_id: 123456, nickname: '' });
  assert.deepEqual(await f.handler.execute({ action: 'get_status' }), { online: true, good: true });
  assert.equal(await f.handler.execute({ action: 'set_input_status', params: { user_id: '654321', event_type: 1 } }), null);
  assert.deepEqual(f.inputs, [[1, 1, 'u_target']]);
});

test('reinitializing a session cancels a pending send before its UID lookup completes', async t => {
  let resolve;
  let sends = 0;
  const session = { init(_config, _a, _b, callbacks) { callbacks.onSessionInitComplete({ result: 0 }); },
    getMsgService: () => ({ addKernelMsgListener: () => 1, removeKernelMsgListener() {}, sendMsg() { sends++; } }),
    getUixConvertService: () => ({ getUid: () => new Promise(done => { resolve = done; }) }),
  };
  const hook = sessionModule.createSessionHook(() => {});
  t.after(() => hook.dispose());
  const facade = hook.hookWrapper({ NodeIQQNTWrapperSession: { get: () => session } });
  const init = () => facade.NodeIQQNTWrapperSession.get().init({ selfUin: self.uin, selfUid: self.uid }, {}, {}, {});
  init();
  await setImmediate();
  const pending = hook.execute(send());
  const cancelled = assert.rejects(pending, error => error.retcode === 1502);
  init();
  await cancelled;
  resolve({ uidInfo: new Map([['654321', 'u_target']]) });
  await setImmediate();
  assert.equal(sends, 0);
});

test('IPC rejects pre-connection actions and cancels an in-flight request on disconnect', async t => {
  const channel = await createNativeChannel();
  t.after(() => channel.close());
  await assert.rejects(channel.request(send()), error => error.retcode === 1502);
  let submitted;
  const submittedPromise = new Promise(resolve => { submitted = resolve; });
  await startNativeFixture(t, {
    channel,
    service: {
      generateMsgUniqueId: () => '9007199254740993',
      sendMsg() { submitted(); return { result: 0 }; },
    },
  });
  const pending = channel.request({ action: 'send_group_msg', params: { group_id: '987654', message: 'mock only' } });
  const cancelled = assert.rejects(pending, error => error.retcode === 1502 && error.message.includes('未确认'));
  await submittedPromise;
  await channel.close();
  await cancelled;
});

test('terminal parser and line input preserve literal text, echo and continue after bad lines', async () => {
  assert.equal(parseInput('/private 654321 [CQ:at,qq=all]').params.auto_escape, true);
  assert.equal(parseInput('/group 987654 hello world').params.message, 'hello world');
  assert.deepEqual(parseInput('/input 654321'), { action: 'set_input_status', params: { user_id: '654321', event_type: 1 } });
  assert.throws(() => parseInput('{bad'), /有效的 JSON/);
  assert.throws(() => parseInput('"/quit"'), /必须为对象/);
  const lines = [];
  const requests = [];
  let quit = 0;
  const input = startCommandInput({ input: Readable.from(['bad\n/login\n{"action":"get_status","echo":0}\n/quit\n']),
    dispatch: async request => { requests.push(request); return { status: 'ok', echo: request.echo }; },
    onQuit: () => { quit++; }, write: line => lines.push(JSON.parse(line)),
  });
  await input.done;
  assert.equal(lines[0].status, 'failed');
  assert.equal(requests.length, 2);
  assert.equal(lines[2].echo, 0);
  assert.equal(quit, 1);
});

test('authenticated IPC runs a text send and typing action end-to-end with a shared message ID', async t => {
  let sends = 0;
  let inputs = 0;
  const fixture = await startNativeFixture(t, {
    init: false,
    service: {
      generateMsgUniqueId: () => '9007199254740993',
      async sendMsg(_id, peer, elements) {
        sends++;
        assert.equal(elements[0].textElement.content, 'test only');
        queueMicrotask(() => fixture.getListener().onMsgInfoListUpdate([{ ...peer, senderUin: self.uin, sendStatus: 2, msgId: '9007199254741999' }]));
        return { result: 0 };
      },
      sendShowInputStatusReq(type, event, uid) { assert.deepEqual([type, event, uid], [1, 1, 'u_target']); inputs++; return { result: 0 }; },
    },
    session: {
      getUixConvertService: () => ({ getUid: async () => ({ uidInfo: new Map([['654321', 'u_target']]) }) }),
    },
  });
  const converter = createEventConverter();
  const notReady = await dispatchAction(fixture.channel, converter, { action: 'get_login_info', echo: false });
  assert.equal(notReady.retcode, 1502);
  assert.equal(notReady.echo, false);
  await fixture.initialize();
  const response = await dispatchAction(fixture.channel, converter, { ...send({ message: 'test only' }), echo: { id: '中文' } });
  assert.deepEqual(response, { status: 'ok', retcode: 0, data: { message_id: 1 }, echo: { id: '中文' } });
  const recalled = converter({ type: 'notice', self, time: '1794470400', event: { notice_type: 'friend_recall', user_id: self.uin },
    message: { chatType: 1, peerUid: 'u_target', msgId: '9007199254741999' }, key: 'recall' });
  assert.equal(recalled.message_id, response.data.message_id);
  const typing = await dispatchAction(fixture.channel, converter, { action: 'set_input_status', params: { user_id: '654321', event_type: 1 } });
  assert.equal(typing.status, 'ok');
  assert.equal(sends, 1);
  assert.equal(inputs, 1);
  assert.equal((await dispatchAction(fixture.channel, converter, { action: 'unknown', echo: null })).retcode, 1404);
});

test('get_image validates parameters, resolves received images via IPC and enriches with url and base64', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openqq-get-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const picPath = join(dir, 'cat.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(picPath, bytes);

  const fixture = await startNativeFixture(t, {
    session: { getUixConvertService: () => ({ getUid: async () => ({ uidInfo: new Map() }) }) },
  });

  const converter = createEventConverter();
  assert.equal((await dispatchAction(fixture.channel, converter, { action: 'get_image', params: {} })).retcode, 1400);
  assert.equal((await dispatchAction(fixture.channel, converter, { action: 'get_image', params: { file: 'missing.png' } })).retcode, 1404);

  const delivered = new Promise(resolve => fixture.channel.events.on('event', event => { if (event.type === 'message') resolve(); }));
  fixture.getListener().onRecvMsg([{
    chatType: 1, msgId: '501', msgTime: '1794470400', peerUid: 'u_other', peerUin: '654321', senderUid: 'u_other', senderUin: '654321',
    elements: [{ elementType: 2, elementId: '901', picElement: { fileName: 'cat.png', md5HexStr: 'deadbeef', fileUuid: 'uuid-cat', fileSize: String(bytes.length), sourcePath: picPath } }],
  }]);
  await delivered;

  const res = await dispatchAction(fixture.channel, converter, { action: 'get_image', params: { file: 'cat.png' }, echo: 'img-1' }, {
    mediaUrl: (p, f) => `http://127.0.0.1:3001/openqq/media/id/${f}`,
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.echo, 'img-1');
  assert.deepEqual([res.data.file, res.data.filename, res.data.file_name, res.data.size, res.data.file_size, res.data.base64],
    [picPath, 'cat.png', 'cat.png', bytes.length, bytes.length, bytes.toString('base64')]);
  assert.equal(res.data.url, 'http://127.0.0.1:3001/openqq/media/id/cat.png');

  assert.equal(typeof nativeEvents.createEventReceiver, 'function');
});

test('redactActionRequest replaces base64:// and data: URIs with size placeholders without mutating the request', () => {
  const payload = Buffer.alloc(1500).toString('base64');
  const wrappedPayload = payload.match(/.{1,76}/g).join('\r\n');
  const original = {
    action: 'send_group_msg',
    params: {
      group_id: 987654,
      message: [
        { type: 'image', data: { file: 'base64://' + payload, summary: '[图]' } },
        { type: 'video', data: { file: 'C:\\clip.mp4', thumb: 'data:image/png;base64,' + wrappedPayload } },
        { type: 'text', data: { text: 'base64://' + payload } },
      ],
    },
  };
  const redacted = redactActionRequest(original);
  assert.equal(redacted.params.message[0].data.file, 'base64://<1.5 KiB>');
  assert.equal(redacted.params.message[0].data.summary, '[图]');
  assert.equal(redacted.params.message[1].data.file, 'C:\\clip.mp4');
  assert.equal(redacted.params.message[1].data.thumb, 'data:image/png;base64,<1.5 KiB>');
  assert.equal(redacted.params.message[2].data.text, 'base64://' + payload);
  assert.equal(original.params.message[0].data.file, 'base64://' + payload);

  const cq = redactActionRequest({
    action: 'send_msg',
    params: {
      user_id: 654321,
      auto_escape: false,
      message: `base64://AAAA hello [CQ:face,id=1][CQ:image,file=base64://${wrappedPayload},summary=x][CQ:record,file=data:audio/wav;base64&#44;${wrappedPayload}]`,
    },
  });
  assert.equal(
    cq.params.message,
    'base64://AAAA hello [CQ:face,id=1][CQ:image,file=base64://<1.5 KiB>,summary=x][CQ:record,file=data:audio/wav;base64&#44;<1.5 KiB>]',
  );

  const literal = { action: 'send_private_msg', params: { user_id: 654321, message: `[CQ:image,file=base64://${payload}]`, auto_escape: true } };
  assert.equal(redactActionRequest(literal), literal);
});

test('redactActionResponse replaces data.base64 with a size placeholder without mutating the response', () => {
  const encoded = Buffer.alloc(1500).toString('base64');
  const original = { status: 'ok', retcode: 0, data: { file: 'cat.png', size: 1500, base64: encoded } };
  const redacted = redactActionResponse(original);
  assert.equal(redacted.data.base64, '<1.5 KiB>');
  assert.equal(redacted.data.file, 'cat.png');
  assert.equal(original.data.base64, encoded);

  const plain = { status: 'ok', retcode: 0, data: { message_id: 1 } };
  assert.equal(redactActionResponse(plain), plain);
  const failed = { status: 'failed', retcode: 1404, data: null, message: 'missing' };
  assert.equal(redactActionResponse(failed), failed);
});
