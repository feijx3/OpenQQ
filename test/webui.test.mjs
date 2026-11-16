import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startWebUI } from '../src/webui.mjs';

async function fixture(t, options = {}) {
  const web = await startWebUI({ port: 0, ...options });
  t.after(() => web.close());
  const token = new URLSearchParams(new URL(web.url).hash.slice(1)).get('token');
  return { web, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } };
}
async function stream(t, web, headers) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(web.origin + '/api/stream', { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    while (!buffer.includes('\n\n')) {
      const part = await reader.read();
      if (part.done) throw new Error('event stream closed');
      buffer += decoder.decode(part.value, { stream: true });
    }
    const end = buffer.indexOf('\n\n');
    const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    return { type: frame.split('\n').find(line => line.startsWith('event: '))?.slice(7),
      data: JSON.parse(frame.split('\n').find(line => line.startsWith('data: ')).slice(6)) };
  };
}

test('WebUI serves local assets with restrictive headers and never embeds its access token', async t => {
  const { web, headers } = await fixture(t);
  for (const path of ['/', '/app.js', '/styles.css']) {
    const response = await fetch(web.origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await response.text()).includes(headers.Authorization.slice(7)), false);
  }
  const page = await fetch(web.origin + '/');
  const nonce = page.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];
  assert.ok((await page.text()).includes('content="' + nonce + '"'));
  assert.match(page.headers.get('content-security-policy'), /script-src 'self';/);
  assert.equal((await fetch(web.origin + '/native/session.cjs', { headers })).status, 404);
  assert.equal((await fetch(web.origin + '/api/stream')).status, 401);
  assert.equal((await fetch(web.origin + '/api/stream', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('WebUI rejects foreign origins and rebinding Host headers before dispatching actions', async t => {
  let actions = 0;
  const { web, headers } = await fixture(t, { dispatch: async () => { actions++; } });
  const response = await fetch(web.origin + '/api/action', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{"action":"send_private_msg"}' });
  assert.equal(response.status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(web.origin + '/', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal(actions, 0);
});

test('WebUI bound to 0.0.0.0 for Docker still rejects DNS rebinding and foreign origins', async t => {
  const { web, headers } = await fixture(t, { host: '0.0.0.0', allowedHosts: ['openqq.local'] });
  const port = new URL(web.origin).port;
  const localRes = await fetch(`http://localhost:${port}/api/metrics`, { headers: { ...headers, Origin: `http://localhost:${port}` } });
  assert.equal(localRes.status, 200);
  const allowedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(web.origin + '/api/metrics', { headers: { Authorization: headers.Authorization, Host: `openqq.local:${port}`, Origin: `http://openqq.local:${port}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(allowedStatus, 200);
  const badOrigin = await fetch(web.origin + '/api/action', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{"action":"get_status"}' });
  assert.equal(badOrigin.status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const request = httpRequest(web.origin + '/', { headers: { Host: `attacker.example:${port}` } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHost, 403);
});

test('JSON action requests reuse the dispatcher and preserve responses and echo', async t => {
  const requests = [];
  const expected = { status: 'ok', retcode: 0, data: { message_id: 7 }, echo: { id: '中文' } };
  const { web, headers } = await fixture(t, { dispatch: async action => { requests.push(action); return expected; } });
  const action = { action: 'send_group_msg', params: { group_id: 987654, message: 'mock only' }, echo: expected.echo };
  const response = await fetch(web.origin + '/api/action', { method: 'POST', headers: { ...headers, Origin: web.origin }, body: JSON.stringify(action) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(requests, [action]);
});

test('invalid/oversized bodies are rejected without dispatch and preview cannot submit QQ actions', async t => {
  let actions = 0;
  const { web, headers } = await fixture(t, { dispatch: async () => { actions++; } });
  for (const [body, code] of [['{bad', 400], ['[]', 400], ['null', 400], ['{}', 400], [JSON.stringify({ action: 'get_status', extra: 'x'.repeat(270000) }), 413]]) {
    assert.equal((await fetch(web.origin + '/api/action', { method: 'POST', headers, body })).status, code);
  }
  assert.equal((await fetch(web.origin + '/api/action', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(actions, 0);
  const preview = await fixture(t);
  const response = await fetch(preview.web.origin + '/api/action', { method: 'POST', headers: preview.headers, body: '{"action":"get_login_info"}' });
  assert.equal((await response.json()).retcode, 1502);
});

test('event stream delivers snapshot, fresh status, Unicode events and error counts', { timeout: 5000 }, async t => {
  const { web, headers } = await fixture(t, { status: { phase: 'starting' } });
  const next = await stream(t, web, headers);
  assert.equal((await next()).data.state.phase, 'starting');
  web.setStatus({ phase: 'session_ready', self_id: '123456' });
  assert.deepEqual(await next(), { type: 'state', data: { phase: 'session_ready', self_id: '123456' } });
  const event = { post_type: 'message', user_id: 654321, message: [{ type: 'text', data: { text: '你好 <img src=x onerror=alert(1)>' } }] };
  web.publish('event', event);
  const received = await next();
  assert.equal(received.type, 'entry');
  assert.deepEqual(received.data.entry.data, event);
  assert.equal(received.data.counts.events, 1);
  web.publish('action', { response: { status: 'failed' } });
  const failure = await next();
  assert.equal(failure.data.counts.actions, 1);
  assert.equal(failure.data.counts.errors, 1);
});

test('reconnecting streams replay bounded history and server shutdown closes live streams', { timeout: 5000 }, async t => {
  const { web, headers } = await fixture(t);
  for (let n = 0; n < 205; n++) web.publish('event', { post_type: 'notice', n });
  const next = await stream(t, web, headers);
  const snapshot = (await next()).data;
  assert.equal(snapshot.entries.length, 200);
  assert.equal(snapshot.entries[0].id, 6);
  assert.equal(snapshot.counts.events, 205);
  for (let n = 0; n < 4; n++) web.publish('event', { text: 'x'.repeat(700000), n });
  const resumed = await stream(t, web, headers);
  assert.equal((await resumed()).data.entries.length, 2);
  await web.close();
});

test('console routes serve the page, fonts are local and /api/metrics reports throughput and action latency', async t => {
  const { web, headers } = await fixture(t);
  for (const path of ['/messages', '/events', '/actions', '/logs', '/account', '/connections', '/settings']) {
    const response = await fetch(web.origin + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
  }
  assert.equal((await fetch(web.origin + '/fonts/inter.woff2')).headers.get('content-type'), 'font/woff2');
  assert.equal((await fetch(web.origin + '/api/metrics')).status, 401);
  web.publish('event', { post_type: 'message', user_id: 1 });
  web.publish('action', { request: { action: 'get_status' }, response: { status: 'ok' }, source: 'webui', elapsed: 12 });
  web.publish('action', { request: { action: 'get_status' }, response: { status: 'failed' }, source: 'onebot', elapsed: 30 });
  const metrics = await (await fetch(web.origin + '/api/metrics', { headers })).json();
  assert.equal(metrics.timeline.length, 60);
  const total = key => metrics.timeline.reduce((sum, bucket) => sum + bucket[key], 0);
  assert.deepEqual([total('events'), total('actions'), total('errors')], [1, 2, 1]);
  assert.deepEqual([metrics.latency.samples, metrics.latency.average, metrics.latency.last], [2, 21, 30]);
  assert.ok(metrics.process.rss > 0 && metrics.uptime >= 0);
});
