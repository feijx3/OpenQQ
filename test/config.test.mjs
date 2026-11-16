import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig, validateConfig, readConfig, saveConfig } from '../src/config.mjs';
import { setupCLI } from '../src/setup.mjs';
import { startWebUI } from '../src/webui.mjs';

test('config persists validated settings atomically and refuses invalid replacement', t => {
  const dir = mkdtempSync(join(tmpdir(), 'openqq-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json'); assert.equal(readConfig(path), null);
  const config = defaultConfig(); assert.notEqual(config.accessToken, defaultConfig().accessToken);
  saveConfig(path, config); assert.deepEqual(readConfig(path), config);
  const before = readFileSync(path, 'utf8');
  for (const change of [{ accessToken: '' }, { webPort: 0 }, { webPort: config.ws.port }, { ws: { ...config.ws, host: 'example.org' } }, { version: 2 },
    { reverseWs: [{ enabled: true, url: 'ws://example.org/?access_token=secret', token: '' }] },
    { reverseWs: [{ enabled: true, url: 'file:///tmp/test', token: '' }] }]) {
    assert.throws(() => saveConfig(path, { ...config, ...change })); assert.equal(readFileSync(path, 'utf8'), before);
  }
  assert.deepEqual(readdirSync(dir), ['config.json']);
  writeFileSync(path, '{broken'); assert.throws(() => readConfig(path), /配置读取失败/);
  assert.throws(() => validateConfig({ ...config, ws: { ...config.ws, enabled: false } }), /至少启用/);
});

test('default WebSocket host follows OPENQQ_WS_HOST (container) and ignores other values', t => {
  const previous = process.env.OPENQQ_WS_HOST;
  t.after(() => { if (previous === undefined) delete process.env.OPENQQ_WS_HOST; else process.env.OPENQQ_WS_HOST = previous; });
  process.env.OPENQQ_WS_HOST = '0.0.0.0'; assert.equal(defaultConfig().ws.host, '0.0.0.0');
  process.env.OPENQQ_WS_HOST = 'example.org'; assert.equal(defaultConfig().ws.host, '127.0.0.1');
  delete process.env.OPENQQ_WS_HOST; assert.equal(defaultConfig().ws.host, '127.0.0.1');
});

test('CLI initialization fails clearly without an interactive terminal', async () => {
  await assert.rejects(setupCLI('unused', defaultConfig(), { input: { isTTY: false } }), /npm run webui/);
});

test('WebUI config/save/start require authentication and use the same validated configuration', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'openqq-setup-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json'); let config = defaultConfig(), started = 0;
  const web = await startWebUI({ port: 0, configuration: { get: () => ({ config }), save: value => ({ config: config = saveConfig(path, value) }), start: () => { started++; return { message: 'started fixture only' }; } } });
  t.after(() => web.close());
  const token = new URLSearchParams(new URL(web.url).hash.slice(1)).get('token');
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  for (const route of ['/api/config', '/api/start']) assert.equal((await fetch(web.origin + route, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal(started, 0);
  assert.equal((await fetch(web.origin + '/api/config', { headers })).status, 200);
  const bad = await fetch(web.origin + '/api/config', { method: 'POST', headers, body: '{}' }); assert.equal(bad.status, 400);
  config.ws.port = 3101;
  assert.equal((await fetch(web.origin + '/api/config', { method: 'POST', headers, body: JSON.stringify(config) })).status, 200);
  assert.equal(readConfig(path).ws.port, 3101);
  await fetch(web.origin + '/api/start', { method: 'POST', headers, body: '{}' }); assert.equal(started, 1);
  for (const asset of ['/setup', '/app.js', '/styles.css', '/logo.svg']) assert.equal((await fetch(web.origin + asset)).status, 200);
  assert.equal((await fetch(web.origin + '/logo.svg')).headers.get('content-type'), 'image/svg+xml');
});
