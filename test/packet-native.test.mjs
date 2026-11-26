import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const { createPacketBootstrap, createPacketSender, configureNativePacket, getPacketSender } = createRequire(import.meta.url)('../native/packet-native.cjs');

function bridge(overrides = {}) {
  return {
    initialize: () => true,
    send() { return { id: "1", promise: Promise.resolve({}) }; },
    release() {},
    ...overrides,
  };
}

test('supported version initializes the bridge once and keeps it reachable', () => {
  let loads = 0;
  let hooks = 0;
  const native = bridge({
    initialize(version) {
      hooks++;
      assert.equal(version, '9.9.33-52230');
      return true;
    },
  });
  const ensure = createPacketBootstrap({
    platform: 'win32',
    arch: 'x64',
    load() { loads++; return native; },
  });
  assert.equal(ensure('9.9.33-52230').native, native);
  ensure('9.9.33-52230');
  assert.equal(loads, 1);
  assert.equal(hooks, 1);
  assert.throws(() => ensure('9.9.37-54395'), /版本不能/);
});

test('native rejection is surfaced and never retried', () => {
  let calls = 0;
  const ensure = createPacketBootstrap({
    platform: 'win32',
    arch: 'x64',
    load: () => bridge({
      initialize(version) {
        calls++;
        throw Error('unsupported QQ packet profile: ' + version + ' (verified: 9.9.33-52230)');
      },
    }),
  });
  assert.throws(() => ensure('9.9.37-54395'), /unsupported QQ packet profile: 9\.9\.37-54395/);
  assert.throws(() => ensure('9.9.37-54395'), /unsupported QQ packet profile/);
  assert.equal(calls, 1);
});

for (const [platform, arch, expected] of [
  ['linux', 'x64', /Linux.*Docker/],
  ['linux', 'arm64', /Linux.*Docker/],
  ['darwin', 'arm64', /darwin/],
  ['win32', 'arm64', /Windows arm64/],
]) {
  test('unsupported environment never loads hooks: ' + platform + '/' + arch, () => {
    let loads = 0;
    const ensure = createPacketBootstrap({ platform, arch, load() { loads++; throw Error('must not load'); } });
    assert.throws(() => ensure('9.9.33-52230'), error => error.retcode === 1500 && expected.test(error.message));
    assert.equal(loads, 0);
  });
}

for (const version of [undefined, null, '', '   ']) {
  test('missing QQ version fails explicitly: ' + JSON.stringify(version), () => {
    let loads = 0;
    const ensure = createPacketBootstrap({
      platform: 'win32', arch: 'x64', load() { loads++; throw Error('must not load'); },
    });
    assert.throws(() => ensure(version), /缺少 QQ 版本号/);
    assert.throws(() => configureNativePacket(version), /缺少 QQ 版本号/);
    assert.equal(loads, 0);
  });
}

test('unconfigured production sender never bypasses the native bridge', () => {
  let calls = 0;
  const service = { sendSsoCmdReqByContend() { calls++; } };
  assert.throws(() => getPacketSender()(service, 'cmd', Buffer.from([1])), /缺少 QQ 版本号/);
  assert.equal(calls, 0);
});

test('managed native request releases its ID exactly once', async () => {
  const releases = [];
  const native = bridge({ release(id) { releases.push(id); } });
  const send = createPacketSender(() => ({ native }));
  const handle = send({}, 'cmd', Buffer.from([1]));
  await handle.promise;
  handle.release(); handle.release();
  assert.deepEqual(releases, ['1']);
});

test('malformed native handle releases an available ID before reporting failure', () => {
  const releases = [];
  const native = bridge({ send: () => ({ id: '3', promise: null }), release(id) { releases.push(id); } });
  assert.throws(() => createPacketSender(() => ({ native }))({}, 'cmd', Buffer.from([1])), /无效的请求句柄/);
  assert.deepEqual(releases, ['3']);
});

test('failed hook is reported and never attempted twice', () => {
  let calls = 0;
  const ensure = createPacketBootstrap({
    platform: 'win32',
    arch: 'x64',
    load: () => bridge({ initialize() { calls++; return false; } }),
  });
  assert.throws(() => ensure('9.9.33-52230'), /未报告/);
  assert.throws(() => ensure('9.9.33-52230'), /未报告/);
  assert.equal(calls, 1);
});

test('own C++ packet bridge fixture', { skip: process.platform !== 'win32' }, () => {
  const build = resolve(import.meta.dirname, '../.runtime/native-build');
  const multiConfig = resolve(build, 'Release/openqq-packet-fixture.exe');
  const fixture = existsSync(multiConfig) ? multiConfig : resolve(build, 'openqq-packet-fixture.exe');
  assert.match(execFileSync(fixture, [], { encoding: 'utf8', windowsHide: true }), /tests passed/);
});
