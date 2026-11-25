import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const { createPacketBootstrap } = createRequire(import.meta.url)('../native/packet-native.cjs');

function bridge(overrides = {}) {
  return {
    initialize: () => true,
    send() {},
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

test('unsupported platform never loads the native bridge', () => {
  const ensure = createPacketBootstrap({
    platform: 'linux',
    arch: 'x64',
    load() { throw Error('must not load'); },
  });
  assert.throws(() => ensure('9.9.33-52230'), /Windows x64/);
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
