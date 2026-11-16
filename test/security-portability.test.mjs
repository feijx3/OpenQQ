import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';

import { isUncPath, probeNative, isQQProcessRunning } from '../src/env.mjs';
import { readPE64Info, readELF64Info, inspectQQ, resolveLinuxWrapper } from '../src/qq.mjs';
import { defaultConfig, validateConfig } from '../src/config.mjs';
import { sanitizeTerminal, createConsole } from '../src/console.mjs';
import { createEventConverter } from '../src/onebot.mjs';
import { startOneBot } from '../src/network.mjs';
import { startWebUI } from '../src/webui.mjs';

const require = createRequire(import.meta.url);
const { validateAction } = require('../native/actions.cjs');
const { createEventReceiver } = require('../native/events.cjs');

const REQUIRED_NAPI_EXPORTS = [
  'qq_magic_napi_register',
  'napi_get_global',
  'napi_set_named_property',
  'napi_create_string_utf8',
  'napi_run_script',
  'napi_open_escapable_handle_scope',
  'napi_close_escapable_handle_scope',
  'napi_escape_handle',
  'napi_is_exception_pending',
  'napi_get_and_clear_last_exception',
];

function makeSyntheticPE64(exportNames = [], machine = 0x8664) {
  const buf = Buffer.alloc(0x2400);
  buf.writeUInt16LE(0x5a4d, 0);
  const peOffset = 0x80;
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x00004550, peOffset);
  buf.writeUInt16LE(machine, peOffset + 4);
  buf.writeUInt16LE(1, peOffset + 6);
  const optSize = 240;
  buf.writeUInt16LE(optSize, peOffset + 20);
  const optOffset = peOffset + 24;
  buf.writeUInt16LE(machine === 0x8664 ? 0x20b : 0x10b, optOffset);
  buf.writeUInt32LE(16, optOffset + 108);
  if (exportNames.length) {
    buf.writeUInt32LE(0x1000, optOffset + 112);
    buf.writeUInt32LE(0x1000, optOffset + 116);
  }
  const secOffset = optOffset + optSize;
  buf.writeUInt32LE(0x2000, secOffset + 8);
  buf.writeUInt32LE(0x1000, secOffset + 12);
  buf.writeUInt32LE(0x2000, secOffset + 16);
  buf.writeUInt32LE(0x400, secOffset + 20);

  if (exportNames.length) {
    const dirFile = 0x400;
    const namesTableFile = dirFile + 40;
    let strFile = namesTableFile + exportNames.length * 4;
    buf.writeUInt32LE(exportNames.length, dirFile + 24);
    buf.writeUInt32LE(0x1000 + 40, dirFile + 32);
    exportNames.forEach((name, idx) => {
      buf.writeUInt32LE(0x1000 + (strFile - dirFile), namesTableFile + idx * 4);
      const written = buf.write(name, strFile, 'ascii');
      buf[strFile + written] = 0;
      strFile += written + 1;
    });
  }
  return buf;
}

function makeSyntheticELF64(exportNames = [], machine = 0x3e) {
  const strChunks = [Buffer.from([0])];
  const nameOffsets = exportNames.map(name => {
    const offset = strChunks.reduce((sum, item) => sum + item.length, 0);
    strChunks.push(Buffer.from(name + '\0', 'utf8'));
    return offset;
  });
  const dynstr = Buffer.concat(strChunks);
  const symCount = exportNames.length + 1; // index 0 = STN_UNDEF
  const dynsym = Buffer.alloc(symCount * 24);
  exportNames.forEach((_, idx) => {
    const off = (idx + 1) * 24;
    dynsym.writeUInt32LE(nameOffsets[idx], off);
    dynsym.writeUInt8((1 << 4) | 2, off + 4); // STB_GLOBAL | STT_FUNC
    dynsym.writeUInt16LE(1, off + 6); // defined section index != SHN_UNDEF
  });

  const ehdrSize = 64;
  const dynstrOffset = ehdrSize;
  const dynsymOffset = dynstrOffset + dynstr.length;
  const shoff = dynsymOffset + dynsym.length;
  const shnum = 3; // NULL, .dynstr, .dynsym
  const buf = Buffer.alloc(shoff + shnum * 64);

  // Elf64_Ehdr
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // ELFDATA2LSB
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(3, 16); // ET_DYN
  buf.writeUInt16LE(machine, 18);
  buf.writeUInt32LE(1, 20);
  buf.writeBigUInt64LE(BigInt(shoff), 40);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(64, 58);
  buf.writeUInt16LE(shnum, 60);

  dynstr.copy(buf, dynstrOffset);
  dynsym.copy(buf, dynsymOffset);

  // Section 1: .dynstr (SHT_STRTAB = 3)
  const sh1 = shoff + 64;
  buf.writeUInt32LE(3, sh1 + 4);
  buf.writeBigUInt64LE(BigInt(dynstrOffset), sh1 + 24);
  buf.writeBigUInt64LE(BigInt(dynstr.length), sh1 + 32);

  // Section 2: .dynsym (SHT_DYNSYM = 11, link = 1)
  const sh2 = shoff + 128;
  buf.writeUInt32LE(11, sh2 + 4);
  buf.writeBigUInt64LE(BigInt(dynsymOffset), sh2 + 24);
  buf.writeBigUInt64LE(BigInt(dynsym.length), sh2 + 32);
  buf.writeUInt32LE(1, sh2 + 40);
  buf.writeBigUInt64LE(24n, sh2 + 56);
  return buf;
}

test('env & config reject UNC paths and do not require an interpreter', () => {
  assert.equal(isUncPath('\\\\server\\share'), true);
  assert.equal(isUncPath('//evil/share'), true);
  assert.equal(isUncPath('C:\\QQ'), false);
  const def = defaultConfig();
  assert.equal(/DeobfTools|D:\\qq/i.test(JSON.stringify(def)), false);
  assert.equal(validateConfig(def).version, 1);
  assert.throws(() => validateConfig({ ...def, qqRoot: '\\\\fileserver\\qq' }), /qqRoot/);
  assert.equal(probeNative(join(tmpdir(), 'openqq-missing-native')).ready, false);
});

test('readPE64Info and inspectQQ verify x64 exports without hard-locking a single QQ version', () => {
  const peValid = makeSyntheticPE64(REQUIRED_NAPI_EXPORTS);
  const parsed = readPE64Info(peValid);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.x64, true);
  assert.equal(parsed.exports.has('qq_magic_napi_register'), true);

  const pe32 = readPE64Info(makeSyntheticPE64([], 0x014c));
  assert.equal(pe32.x64, false);
  assert.equal(readPE64Info(Buffer.from('not-a-pe')).valid, false);

  const root = mkdtempSync(join(tmpdir(), 'openqq-qq-'));
  try {
    const version = '9.9.99-12345';
    const verDir = join(root, 'versions', version);
    const appDir = join(verDir, 'resources', 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(root, 'QQ.exe'), Buffer.from('MZ'));
    writeFileSync(join(root, 'versions', 'config.json'), JSON.stringify({ curVersion: version }));
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ version, eleArch: 'x64' }));
    writeFileSync(join(verDir, 'QQNT.dll'), peValid);
    writeFileSync(join(appDir, 'wrapper.node'), makeSyntheticPE64([]));

    const info = inspectQQ(root);
    assert.equal(info.version, version);
    assert.equal(info.supported, true);
    assert.equal(info.targetMatch, false);
    assert.deepEqual(info.missingExports, []);
    assert.equal(info.fuses, null);

    // Removing a required N-API export flips supported to false
    writeFileSync(join(verDir, 'QQNT.dll'), makeSyntheticPE64(['napi_get_global']));
    const incomplete = inspectQQ(root);
    assert.equal(incomplete.supported, false);
    assert.ok(incomplete.missingExports.includes('qq_magic_napi_register'));

    assert.throws(() => inspectQQ('\\\\server\\share\\QQNT'), /无效/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readELF64Info and inspectQQ verify Linux x64/arm64 ELF exports and hot-update wrappers', () => {
  const elfValid = makeSyntheticELF64(REQUIRED_NAPI_EXPORTS, 0x3e);
  const parsed = readELF64Info(elfValid);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.x64, true);
  assert.equal(parsed.arch, 'x64');
  assert.equal(parsed.exports.has('qq_magic_napi_register'), true);

  const armValid = makeSyntheticELF64(REQUIRED_NAPI_EXPORTS, 0xb7);
  assert.equal(readELF64Info(armValid).arch, 'arm64');
  assert.equal(readELF64Info(Buffer.from('not-an-elf')).valid, false);

  const root = mkdtempSync(join(tmpdir(), 'openqq-linux-qq-'));
  const configHome = mkdtempSync(join(tmpdir(), 'openqq-xdg-'));
  try {
    const version = '3.2.15-30366';
    const appDir = join(root, 'resources', 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'qq-chat', version, eleArch: 'x64' }));
    writeFileSync(join(root, 'qq'), elfValid);
    writeFileSync(join(appDir, 'wrapper.node'), makeSyntheticELF64([], 0x3e));

    const info = inspectQQ(root);
    assert.equal(info.platform, 'linux');
    assert.equal(info.version, version);
    assert.equal(info.arch, 'x64');
    assert.equal(info.supported, true);
    assert.deepEqual(info.missingExports, []);
    assert.equal(resolveLinuxWrapper(info, configHome), info.wrapper);

    // Hot-updated wrapper.node in $XDG_CONFIG_HOME/QQ/versions/<curVersion> is picked up when valid
    const hotVer = '3.2.16-31000';
    const hotDir = join(configHome, 'QQ', 'versions', hotVer, 'resources', 'app');
    mkdirSync(hotDir, { recursive: true });
    writeFileSync(join(configHome, 'QQ', 'versions', 'config.json'), JSON.stringify({ curVersion: hotVer }));
    const hotWrapper = join(hotDir, 'wrapper.node');
    writeFileSync(hotWrapper, makeSyntheticELF64([], 0x3e));
    assert.equal(resolveLinuxWrapper(info, configHome), hotWrapper);

    // Architecture mismatch flips supported to false
    writeFileSync(join(appDir, 'wrapper.node'), makeSyntheticELF64([], 0xb7));
    assert.equal(inspectQQ(root).supported, false);

    // Missing required N-API export flips supported to false
    writeFileSync(join(appDir, 'wrapper.node'), makeSyntheticELF64([], 0x3e));
    writeFileSync(join(root, 'qq'), makeSyntheticELF64(['napi_get_global'], 0x3e));
    const incomplete = inspectQQ(root);
    assert.equal(incomplete.supported, false);
    assert.ok(incomplete.missingExports.includes('qq_magic_napi_register'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
});

test('isQQProcessRunning checks /proc on Linux without matching node or openqq', { skip: process.platform !== 'linux' }, t => {
  const procRoot = mkdtempSync(join(tmpdir(), 'openqq-proc-'));
  t.after(() => rmSync(procRoot, { recursive: true, force: true }));
  mkdirSync(join(procRoot, '999991'));
  writeFileSync(join(procRoot, '999991', 'comm'), 'node\n');
  writeFileSync(join(procRoot, '999991', 'cmdline'), 'node\0/opt/openqq/src/main.mjs\0');
  assert.equal(isQQProcessRunning(procRoot), false);

  mkdirSync(join(procRoot, '999992'));
  writeFileSync(join(procRoot, '999992', 'comm'), 'qq\n');
  writeFileSync(join(procRoot, '999992', 'cmdline'), '/opt/QQ/qq\0--no-sandbox\0');
  assert.equal(isQQProcessRunning(procRoot), true);
});

test('sanitizeTerminal strips ANSI/OSC control bytes and prototype keys remain safe', () => {
  const dirty = 'hi\x1b[31mRED\x1b[0m\x1b]0;pwned\x07\r\nnext\x9bc0';
  const cleaned = sanitizeTerminal(dirty);
  assert.equal(cleaned.includes('\x1b'), false);
  assert.equal(cleaned.includes('\x07'), false);
  assert.equal(cleaned.includes('\x9b'), false);
  assert.ok(cleaned.includes('hiRED'));

  const chunks = [];
  const stdout = new PassThrough();
  stdout.on('data', chunk => chunks.push(chunk.toString('utf8')));
  const consoleOut = createConsole({ mode: 'pretty', stdout, stderr: new PassThrough(), env: { NO_COLOR: '1' } });
  consoleOut.action({ action: 'toString', params: {} }, { status: 'failed', retcode: 1404, message: 'bad\x1b[2J' }, 'webui');
  const out = chunks.join('');
  assert.equal(out.includes('\x1b['), false);

  const convert = createEventConverter();
  assert.throws(() => convert({ type: 'message', self: { uin: [10001] }, message: { chatType: 1, msgId: '1', msgTime: 1, senderUin: '2', elements: [{ elementType: 1, textElement: { content: 'a' } }] } }), /标识/);
  assert.doesNotThrow(() => convert({ type: 'notice', time: 1, self: { uin: '10001' }, event: { notice_type: 'toString', user_id: '20002' } }));
  assert.throws(() => validateAction({ action: 'send_private_msg', params: { user_id: [123456], message: 'hi' } }), /数值标识/);
});

test('native event receiver deduplicates bounded callback shapes and guards null input status pushes', async () => {
  const emitted = [];
  const receiver = createEventReceiver({}, { uid: 'u_1', uin: '10001' }, item => emitted.push(item), () => true);

  await assert.doesNotReject(() => receiver('msg', 'onInputStatusPush', [null]));
  await assert.doesNotReject(() => receiver('msg', 'onInputStatusPush', ['bad']));

  for (let i = 0; i < 600; i++) {
    await receiver('msg', `unknown_cb_${i}`, [{ a: i }]);
  }
  const beforeRepeat = emitted.filter(e => e.type === 'native_callback').length;
  assert.equal(beforeRepeat, 600);
  // Most recent 500 shapes stay deduplicated even after eviction of the oldest 100
  await receiver('msg', 'unknown_cb_599', [{ a: 599 }]);
  assert.equal(emitted.filter(e => e.type === 'native_callback').length, 600);
});

test('forward WS rejects // URLs, requires strict Bearer header and rate limits 401 failures', async () => {
  const accessToken = 'secret-token-0123456789';
  let address = '';
  const net = await startOneBot({
    config: { version: 1, qqRoot: 'C:\\QQ', webPort: 17860, accessToken, ws: { enabled: true, host: '127.0.0.1', port: 0 }, reverseWs: [] },
    dispatch: async () => ({ status: 'ok', retcode: 0, data: null }),
    onStatus: status => { if (status.ws?.address) address = status.ws.address; },
  });
  try {
    const port = new URL(address).port;
    // Reject protocol-relative // URLs before URL parsing
    const rawResp = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '//evil.example/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
      req.on('close', () => resolve('closed'));
      req.on('error', () => resolve('errored'));
      req.end();
      setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 2000).unref();
    });
    assert.ok(['closed', 'errored'].includes(rawResp));

    // Reject missing Bearer prefix on Authorization header even if token text matches
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(address, { headers: { Authorization: accessToken } });
        ws.once('open', () => { ws.terminate(); resolve(); });
        ws.once('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); reject(new Error('HTTP ' + res.statusCode)); });
        ws.once('error', reject);
      }),
      /HTTP 401/,
    );

    // Accept case-insensitive Bearer prefix
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(address, { headers: { Authorization: 'bearer ' + accessToken } });
      ws.once('open', () => ws.close());
      ws.once('close', () => resolve());
      ws.once('error', reject);
    });

    // Trigger 20 bad auth attempts, then expect 429 rate limit
    let saw429 = false;
    for (let i = 0; i < 22; i++) {
      await new Promise(resolve => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Authorization: 'Bearer wrong-token' } });
        req.on('response', res => { if (res.statusCode === 429) saw429 = true; res.resume(); req.destroy(); resolve(); });
        req.on('upgrade', (_res, sock) => { sock.destroy(); resolve(); });
        req.on('error', () => resolve());
        req.end();
      });
    }
    assert.equal(saw429, true);
  } finally {
    await net.close();
  }
});

test('WebUI serves theme.css, POST /api/check and updated custom SVG UI without AI/personal strings', async () => {
  let checkedBody = null;
  const ui = await startWebUI({
    port: 0,
    configuration: {
      get: () => ({ config: defaultConfig(), initialized: false, running: false, configPath: 'config/openqq.json', detected: { qq: { valid: false }, native: { ready: false } } }),
      check: body => { checkedBody = body; return { ok: true, received: body }; },
      save: value => ({ config: value, restartRequired: false, message: 'ok' }),
      start: () => ({ message: 'starting' }),
    },
  });
  const token = ui.url.split('#token=')[1];
  try {
    const themeRes = await fetch(ui.origin + '/theme.css');
    assert.equal(themeRes.status, 200);
    assert.match(await themeRes.text(), /--accent:/);

    const checkNoAuth = await fetch(ui.origin + '/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(checkNoAuth.status, 401);

    const checkOk = await fetch(ui.origin + '/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'bearer ' + token },
      body: JSON.stringify({ qqRoot: 'C:\\QQNT' }),
    });
    assert.equal(checkOk.status, 200);
    assert.deepEqual(checkedBody, { qqRoot: 'C:\\QQNT' });

    const forbidden = /DeobfTools|Asia\/Singapore|连接，从这里开始|你的 OpenQQ，准备好了|设置助理|D:\\\\qq/;
    // web/ is built from ui/ (npm run build); scan both the shipped files and their sources.
    for (const file of ['web/index.html', 'web/setup.html', 'web/app.js', 'web/app.css', 'web/theme.css', ...readdirSync('ui', { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => item.parentPath + '/' + item.name)]) {
      const content = readFileSync(file, 'utf8');
      assert.equal(forbidden.test(content), false, `${file} contains personal or AI copy`);
    }
    for (const page of ['web/index.html', 'web/setup.html']) {
      const html = readFileSync(page, 'utf8');
      assert.ok(html.indexOf('/theme.css') !== -1 && html.indexOf('/theme.css') < html.indexOf('/styles.css'), `${page} must load theme tokens before styles`);
      assert.ok(html.includes('src="/app.js"'));
    }
    assert.ok(readFileSync('web/app.js', 'utf8').includes('brand-mark'));
    assert.match(readFileSync('web/theme.css', 'utf8'), /prefers-color-scheme: dark/);
  } finally {
    await ui.close();
  }
});
