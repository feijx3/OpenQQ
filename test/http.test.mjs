import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { defaultConfig, validateConfig } from '../src/config.mjs';
import { startOneBot } from '../src/network.mjs';
import { quickActions } from '../src/quick.mjs';
import { dispatchAction } from '../src/actions.mjs';
import { createEventConverter } from '../src/onebot.mjs';

const ok = data => ({ status: 'ok', retcode: 0, data });

async function until(check, message = 'condition') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for ' + message);
}

async function fixture(t, { dispatch, ready = true, wsEnabled = false, posts = [], ...options } = {}) {
  const config = defaultConfig();
  config.ws = { ...config.ws, enabled: wsEnabled, port: 0 };
  config.http = { enabled: true, host: '127.0.0.1', port: 0 };
  config.httpPost = posts;
  const requests = [];
  let state;
  const network = await startOneBot({ config, onStatus: value => { state = value; }, dispatch: dispatch ?? (async request => { requests.push(request); return ok({ message_id: 123 }); }), ...options });
  t.after(() => network.close());
  if (ready) network.setStatus({ phase: 'session_ready', self_id: 12345 });
  return { network, config, requests, address: state.http.address, state: () => state };
}
const auth = f => ({ Authorization: 'Bearer ' + f.config.accessToken });
const call = (f, path, init = {}) => fetch(f.address + path, { ...init, headers: { ...auth(f), ...init.headers } });
const json = (value, extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });

async function receiver(t, answer) {
  const posts = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const post = { headers: req.headers, raw, body: JSON.parse(raw) };
    posts.push(post);
    const reply = (await answer?.(post, posts.length)) ?? { status: 204 };
    res.writeHead(reply.status, reply.body === undefined ? {} : { 'Content-Type': 'application/json' });
    res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${server.address().port}/hook`, posts };
}

const privateMessage = { post_type: 'message', message_type: 'private', user_id: 44, message_id: 7, self_id: 12345, message: [{ type: 'text', data: { text: 'hi' } }] };
const groupMessage = { ...privateMessage, message_type: 'group', group_id: 987654 };

test('the HTTP API needs the access token: 401 without it, 403 with a wrong one, Bearer, Token and query forms all work', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.address + '/get_status')).status, 401);
  assert.equal((await fetch(f.address + '/get_status', { headers: { Authorization: 'Bearer ' + 'x'.repeat(40) } })).status, 403);
  assert.equal(f.requests.length, 0, 'nothing is dispatched without a valid token');
  for (const headers of [{ Authorization: 'Bearer ' + f.config.accessToken }, { Authorization: 'Token ' + f.config.accessToken }]) {
    const response = await fetch(f.address + '/get_status', { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), ok({ message_id: 123 }));
  }
  assert.equal((await fetch(f.address + '/get_status?access_token=' + f.config.accessToken)).status, 200);
  assert.deepEqual(f.requests.map(request => request.action), ['get_status', 'get_status', 'get_status']);
});

test('parameters come from the query string, a JSON body or a form, and the token is never passed on', async t => {
  const f = await fixture(t);
  await call(f, '/send_msg?message_type=private&user_id=44&message=hi&auto_escape=true&access_token=ignored');
  await call(f, '/send_private_msg', json({ user_id: 44, message: [{ type: 'text', data: { text: 'x' } }] }));
  await call(f, '/send_private_msg?user_id=1', json({ user_id: 2, message: 'body wins' }));
  await call(f, '/send_group_msg', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams({ group_id: '987654', message: JSON.stringify([{ type: 'text', data: { text: 'segments' } }]), auto_escape: 'false' }).toString() });
  await call(f, '/set_group_card?group_id=1&user_id=2&card=true');
  await call(f, '/get_status', { method: 'POST' });
  assert.deepEqual(f.requests, [
    { action: 'send_msg', params: { message_type: 'private', user_id: '44', message: 'hi', auto_escape: true } },
    { action: 'send_private_msg', params: { user_id: 44, message: [{ type: 'text', data: { text: 'x' } }] } },
    { action: 'send_private_msg', params: { user_id: 2, message: 'body wins' } },
    { action: 'send_group_msg', params: { group_id: '987654', message: [{ type: 'text', data: { text: 'segments' } }], auto_escape: false } },
    { action: 'set_group_card', params: { group_id: '1', user_id: '2', card: 'true' } },
    { action: 'get_status', params: {} },
  ]);
});

test('malformed HTTP requests are refused with the status OneBot clients expect', async t => {
  const f = await fixture(t, { maxPayload: 64 });
  assert.equal((await call(f, '/')).status, 404);
  assert.equal((await call(f, '/bad%20name')).status, 404);
  assert.equal((await call(f, '/' + 'a'.repeat(65))).status, 404);
  assert.equal((await call(f, '/get_status', { method: 'PUT' })).status, 405);
  assert.equal((await call(f, '/get_status', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 406);
  assert.equal((await call(f, '/get_status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await call(f, '/get_status', json([1]))).status, 400);
  const tooLarge = await call(f, '/send_msg', json({ message: 'x'.repeat(200) }));
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).retcode, 1400);
  assert.equal(f.requests.length, 0);
});

test('actions wait for the QQ session: the answer says so instead of an HTTP error', async t => {
  const f = await fixture(t, { ready: false });
  const response = await call(f, '/get_status');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'failed', retcode: 1502, data: null, message: 'QQ 尚未就绪' });
  assert.equal(f.requests.length, 0);
});

test('_async answers at once and keeps running, _rate_limited behaves like a normal call, and the suffix never reaches the dispatcher', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = [];
  const f = await fixture(t, { dispatch: async request => { seen.push(request); await gate; return ok({ message_id: 9 }); } });
  const early = await call(f, '/send_private_msg_async', json({ user_id: 44, message: 'hi' }));
  assert.deepEqual(await early.json(), { status: 'async', retcode: 1, data: null });
  assert.deepEqual(seen.map(request => request.action), ['send_private_msg']);
  const limited = call(f, '/send_private_msg_rate_limited', json({ user_id: 44, message: 'again' }));
  await until(() => seen.length === 2, 'the second dispatch');
  release();
  assert.deepEqual(await (await limited).json(), ok({ message_id: 9 }));
  assert.deepEqual(seen.map(request => request.action), ['send_private_msg', 'send_private_msg']);
});

test('HTTP actions are limited to 16 at a time', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started = 0;
  const f = await fixture(t, { dispatch: async () => { started++; await gate; return ok(null); } });
  const pending = Array.from({ length: 16 }, () => call(f, '/get_status'));
  await until(() => started === 16, 'sixteen running actions');
  const extra = await (await call(f, '/get_status')).json();
  assert.equal(extra.retcode, 1503);
  release();
  for (const response of await Promise.all(pending)) assert.equal((await response.json()).retcode, 0);
  assert.equal((await (await call(f, '/get_status')).json()).retcode, 0, 'the slots are free again');
});

test('.handle_quick_operation runs the derived actions in order over HTTP and WebSocket, and reports the first failure', async t => {
  const f = await fixture(t, { wsEnabled: true, dispatch: async request => {
    f.requests.push(request);
    return request.action === 'set_group_kick' ? { status: 'failed', retcode: 1500, data: null, message: 'nope' } : ok(null);
  } });
  const operation = { reply: 'pong', at_sender: false, delete: true };
  const done = await (await call(f, '/.handle_quick_operation', json({ context: groupMessage, operation }))).json();
  assert.deepEqual(done, ok(null));
  assert.deepEqual(f.requests, [
    { action: 'send_msg', params: { message_type: 'group', group_id: 987654, message: 'pong' } },
    { action: 'delete_msg', params: { message_id: 7 } },
  ]);

  f.requests.length = 0;
  const failed = await (await call(f, '/.handle_quick_operation', json({ context: groupMessage, operation: { kick: true, ban: true } }))).json();
  assert.deepEqual(failed, { status: 'failed', retcode: 1500, data: null, message: 'nope' });
  assert.deepEqual(f.requests.map(request => request.action), ['set_group_kick'], 'later actions are skipped after a failure');

  const bad = await (await call(f, '/.handle_quick_operation', json({ context: { post_type: 'notice' }, operation: {} }))).json();
  assert.equal(bad.retcode, 1400);
  const later = await (await call(f, '/.handle_quick_operation_async', json({ context: privateMessage, operation: { reply: 'x' } }))).json();
  assert.equal(later.status, 'async');

  f.requests.length = 0;
  const socket = new WebSocket(f.state().ws.address, { headers: auth(f) });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const reply = new Promise(resolve => socket.on('message', data => { const item = JSON.parse(data.toString()); if (item.echo === 'q') resolve(item); }));
  socket.send(JSON.stringify({ action: '.handle_quick_operation', params: { context: privateMessage, operation: { reply: 'over ws' } }, echo: 'q' }));
  assert.deepEqual(await reply, { ...ok(null), echo: 'q' });
  assert.deepEqual(f.requests, [{ action: 'send_msg', params: { message_type: 'private', user_id: 44, message: 'over ws' } }]);
});

test('with only the HTTP server enabled it also serves the media links, without a token', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openqq-http-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'a.bin');
  await writeFile(file, 'payload');
  const f = await fixture(t);
  const link = f.network.mediaUrl(file, 'a.bin');
  assert.ok(link.startsWith(f.address + '/openqq/media/'), link);
  const response = await fetch(link);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'payload');
});

test('HTTP POST reporting sends messages, notices and requests with the headers OneBot receivers verify, and never meta events', async t => {
  const hook = await receiver(t);
  const off = await receiver(t);
  const f = await fixture(t, { posts: [{ enabled: true, url: hook.url, secret: 'shared-secret' }, { enabled: false, url: off.url, secret: '' }] });
  assert.deepEqual(f.state().httpPost, [{ index: 0, state: 'waiting' }]);
  f.network.broadcast({ post_type: 'meta_event', meta_event_type: 'heartbeat' });
  f.network.broadcast(privateMessage);
  f.network.broadcast({ post_type: 'notice', notice_type: 'friend_add', user_id: 44 });
  f.network.broadcast({ post_type: 'request', request_type: 'friend', flag: 'f:u_x:1' });
  await until(() => hook.posts.length === 3, 'three reports');
  assert.deepEqual(hook.posts.map(post => post.body.post_type).sort(), ['message', 'notice', 'request']);
  for (const post of hook.posts) {
    assert.match(post.headers['content-type'], /application\/json/);
    assert.equal(post.headers['x-self-id'], '12345');
    assert.equal(post.headers['x-signature'], 'sha1=' + createHmac('sha1', 'shared-secret').update(post.raw).digest('hex'));
  }
  // 三个 POST 到达接收端时，发送端那侧的 fetch 可能还没 resolve，state 仍会读到 waiting。
  // 等它落定再断言，否则这个用例会随着机器负载时通时不通。
  await until(() => f.state().httpPost[0]?.state === 'ok', 'receiver state ok');
  assert.deepEqual(f.state().httpPost, [{ index: 0, state: 'ok' }]);
  assert.equal(off.posts.length, 0, 'disabled receivers get nothing');
});

test('HTTP POST receivers without a secret get no signature, and their health follows the answers', async t => {
  let status = 500;
  const hook = await receiver(t, () => ({ status }));
  const f = await fixture(t, { posts: [{ enabled: true, url: hook.url, secret: '' }] });
  f.network.broadcast(privateMessage);
  await until(() => f.state().httpPost[0].state === 'failed', 'a failed state after HTTP 500');
  assert.equal(hook.posts[0].headers['x-signature'], undefined);
  status = 204;
  f.network.broadcast(privateMessage);
  await until(() => f.state().httpPost[0].state === 'ok', 'recovery');
});

test('an unreachable or slow receiver is reported as failed without blocking the others', async t => {
  const slow = await receiver(t, () => new Promise(() => {}));
  const live = await receiver(t);
  const dead = createServer(); dead.listen(0, '127.0.0.1'); await once(dead, 'listening');
  const deadUrl = `http://127.0.0.1:${dead.address().port}/`;
  dead.close(); await once(dead, 'close');
  const f = await fixture(t, { postTimeoutMs: 100, posts: [{ enabled: true, url: deadUrl, secret: '' }, { enabled: true, url: slow.url, secret: '' }, { enabled: true, url: live.url, secret: '' }] });
  f.network.broadcast(privateMessage);
  await until(() => live.posts.length === 1, 'the healthy receiver');
  await until(() => f.state().httpPost.every(item => item.state !== 'waiting'), 'verdicts for every receiver');
  assert.deepEqual(f.state().httpPost.map(item => item.state), ['failed', 'failed', 'ok']);
});

test('a quick operation in the POST response is carried out for messages and requests only', async t => {
  const answers = [
    { status: 200, body: { reply: 'pong', at_sender: false } },
    { status: 200, body: { reply: 'ignored for notices' } },
    { status: 200, body: { approve: true, remark: 'pal' } },
    { status: 200, body: {} },
    { status: 200, body: [1, 2] },
    { status: 204 },
  ];
  const hook = await receiver(t, (_post, count) => answers[count - 1]);
  const f = await fixture(t, { posts: [{ enabled: true, url: hook.url, secret: '' }] });
  const send = async event => { const before = hook.posts.length; f.network.broadcast(event); await until(() => hook.posts.length === before + 1, 'a report'); await new Promise(resolve => setTimeout(resolve, 30)); };
  await send(privateMessage);
  await send({ post_type: 'notice', notice_type: 'friend_add', user_id: 44 });
  await send({ post_type: 'request', request_type: 'friend', flag: 'f:u_x:1', user_id: 44 });
  await send(privateMessage);
  await send(privateMessage);
  await send(privateMessage);
  assert.deepEqual(f.requests, [
    { action: 'send_msg', params: { message_type: 'private', user_id: 44, message: 'pong' } },
    { action: 'set_friend_add_request', params: { flag: 'f:u_x:1', approve: true, remark: 'pal' } },
  ]);
});

test('HTTP calls and quick operations run through the real action pipeline, validation included', async t => {
  const sent = [];
  const channel = { request: async request => { sent.push(request); return ok({ self: { uin: '12345' }, message: { chatType: 2, peerUid: '987654', msgId: String(9000 + sent.length) } }); } };
  const converter = createEventConverter();
  const f = await fixture(t, { dispatch: request => dispatchAction(channel, converter, request) });

  const posted = await (await call(f, '/send_group_msg', json({ group_id: 987654, message: 'hello' }))).json();
  assert.equal(posted.status, 'ok');
  assert.ok(Number.isInteger(posted.data.message_id));
  assert.equal(sent[0].params.message[0].data.text, 'hello', 'a string message is parsed before it reaches QQ');

  const viaForm = await (await call(f, '/send_group_msg?group_id=987654&message=%5BCQ%3Aat%2Cqq%3Dall%5D%20hi&auto_escape=false')).json();
  assert.equal(viaForm.status, 'ok');
  assert.deepEqual(sent[1].params.message.map(segment => segment.type), ['at', 'text']);

  const quick = await (await call(f, '/.handle_quick_operation', json({ context: groupMessage, operation: { reply: 'pong' } }))).json();
  assert.equal(quick.status, 'ok');
  assert.deepEqual(sent[2].params.message.map(segment => [segment.type, segment.data.qq ?? segment.data.text]), [['at', '44'], ['text', ' pong']]);

  const invalid = await (await call(f, '/send_group_msg', json({ group_id: 'abc', message: 'x' }))).json();
  assert.equal(invalid.retcode, 1400, 'the usual parameter validation still applies over HTTP');
  const unknown = await (await call(f, '/no_such_action')).json();
  assert.equal(unknown.retcode, 1404);
  assert.equal(sent.length, 3);
});

test('a startup failure of the HTTP port does not leave the WebSocket server running', async t => {
  const taken = createServer(); taken.listen(0, '127.0.0.1'); await once(taken, 'listening');
  t.after(() => taken.close());
  const config = defaultConfig();
  config.ws.port = 0;
  config.http = { enabled: true, host: '127.0.0.1', port: taken.address().port };
  await assert.rejects(startOneBot({ config, dispatch: async () => ok(null) }), /EADDRINUSE/);
});

test('quick operations map to actions as the OneBot v11 specification describes', () => {
  assert.deepEqual(quickActions(groupMessage, { reply: 'hello' }), [{ action: 'send_msg',
    params: { message_type: 'group', group_id: 987654, message: '[CQ:at,qq=44] hello' } }], 'groups mention the sender by default');
  assert.deepEqual(quickActions(privateMessage, { reply: 'hello', at_sender: true }), [{ action: 'send_msg',
    params: { message_type: 'private', user_id: 44, message: 'hello' } }], 'private chats never mention');
  assert.deepEqual(quickActions(groupMessage, { reply: '[CQ:face,id=1]', auto_escape: true })[0].params.message,
    [{ type: 'at', data: { qq: '44' } }, { type: 'text', data: { text: ' [CQ:face,id=1]' } }]);
  assert.deepEqual(quickActions(groupMessage, { reply: [{ type: 'text', data: { text: 'x' } }], at_sender: false })[0].params.message, [{ type: 'text', data: { text: 'x' } }]);
  assert.deepEqual(quickActions(groupMessage, { reply: '' }), []);
  assert.deepEqual(quickActions(groupMessage, { delete: true, kick: true, ban: true }), [
    { action: 'delete_msg', params: { message_id: 7 } },
    { action: 'set_group_kick', params: { group_id: 987654, user_id: 44, reject_add_request: false } },
    { action: 'set_group_ban', params: { group_id: 987654, user_id: 44, duration: 1800 } },
  ]);
  assert.equal(quickActions(groupMessage, { ban: true, ban_duration: 60 })[0].params.duration, 60);
  assert.deepEqual(quickActions(privateMessage, { delete: true, kick: true, ban: true }), [], 'group-only operations are ignored in private chats');
  assert.deepEqual(quickActions({ post_type: 'request', request_type: 'friend', flag: 'f:u_x:1' }, { approve: false }),
    [{ action: 'set_friend_add_request', params: { flag: 'f:u_x:1', approve: false } }]);
  assert.deepEqual(quickActions({ post_type: 'request', request_type: 'group', sub_type: 'invite', flag: 'g:1:1:2' }, { approve: false, reason: 'no' }),
    [{ action: 'set_group_add_request', params: { flag: 'g:1:1:2', sub_type: 'invite', approve: false, reason: 'no' } }]);
  assert.deepEqual(quickActions({ post_type: 'request', request_type: 'friend', flag: 'f:u_x:1' }, { remark: 'only a remark' }), [], 'requests are never answered implicitly');
  for (const [context, operation] of [[groupMessage, { reply: 5 }], [groupMessage, { delete: 'yes' }], [groupMessage, { ban: true, ban_duration: -1 }], [{ post_type: 'notice' }, {}],
    [{ post_type: 'request', request_type: 'other' }, {}], [null, {}], [groupMessage, null], [groupMessage, []]]) {
    assert.throws(() => quickActions(context, operation), error => error.retcode === 1400, JSON.stringify([context, operation]));
  }
});

test('the HTTP options are optional in old config files, validated when present, and one access path must stay enabled', () => {
  const base = defaultConfig();
  const legacy = { ...base }; delete legacy.http; delete legacy.httpPost;
  assert.deepEqual(validateConfig(legacy).http, { enabled: false, host: '127.0.0.1', port: 5700 });
  assert.deepEqual(validateConfig(legacy).httpPost, []);
  const withHttp = validateConfig({ ...base, http: { enabled: true, host: '0.0.0.0', port: 5701 }, httpPost: [{ enabled: true, url: 'https://bot.example/hook?x=1', secret: 'abc' }, { enabled: false, url: 'http://127.0.0.1:8080/', secret: '' }] });
  assert.deepEqual(withHttp.http, { enabled: true, host: '0.0.0.0', port: 5701 });
  assert.deepEqual(withHttp.httpPost.map(item => [item.enabled, item.url, item.secret]), [[true, 'https://bot.example/hook?x=1', 'abc'], [false, 'http://127.0.0.1:8080/', '']]);
  assert.equal(validateConfig({ ...base, httpPost: [{ enabled: true, url: 'http://bot.example/hook' }] }).httpPost[0].secret, '', 'the secret defaults to none');

  assert.throws(() => validateConfig({ ...base, http: { enabled: true, host: '127.0.0.1', port: base.webPort } }), /WebUI 和 HTTP 端口/);
  assert.throws(() => validateConfig({ ...base, http: { enabled: true, host: '127.0.0.1', port: base.ws.port } }), /WebSocket 和 HTTP 端口/);
  assert.doesNotThrow(() => validateConfig({ ...base, ws: { ...base.ws, enabled: false }, http: { enabled: true, host: '127.0.0.1', port: base.ws.port } }), 'a disabled WebSocket does not hold its port');
  assert.doesNotThrow(() => validateConfig({ ...base, http: { enabled: false, host: '127.0.0.1', port: base.webPort } }), 'a disabled HTTP server does not hold its port');
  assert.throws(() => validateConfig({ ...base, http: { enabled: true, host: '192.168.1.2', port: 5700 } }), /HTTP 服务端配置无效/);
  assert.throws(() => validateConfig({ ...base, http: { enabled: 'yes', host: '127.0.0.1', port: 5700 } }), /HTTP 服务端配置无效/);
  for (const url of ['ftp://bot.example/', 'ws://bot.example/', 'not a url', 'http://user:pass@bot.example/', 'http://bot.example/#frag']) {
    assert.throws(() => validateConfig({ ...base, httpPost: [{ enabled: true, url, secret: '' }] }), /上报/, url);
  }
  assert.throws(() => validateConfig({ ...base, httpPost: [{ enabled: true, url: 'http://bot.example/', secret: 'has space' }] }), /密钥/);
  assert.throws(() => validateConfig({ ...base, httpPost: Array.from({ length: 9 }, () => ({ enabled: true, url: 'http://bot.example/', secret: '' })) }), /最多配置 8 个/);

  const none = { ...base, ws: { ...base.ws, enabled: false } };
  assert.throws(() => validateConfig(none), /至少启用一种接入方式/);
  assert.throws(() => validateConfig({ ...none, http: { enabled: false, host: '127.0.0.1', port: 5700 }, httpPost: [{ enabled: false, url: 'http://bot.example/', secret: '' }] }), /至少启用/);
  assert.doesNotThrow(() => validateConfig({ ...none, http: { enabled: true, host: '127.0.0.1', port: 5700 } }));
  assert.doesNotThrow(() => validateConfig({ ...none, httpPost: [{ enabled: true, url: 'http://bot.example/', secret: '' }] }));
});
