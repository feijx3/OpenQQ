import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bootstrapInput } from '../src/qq.mjs';

const win = process.platform === 'win32';
const linux = process.platform === 'linux';
const root = resolve(import.meta.dirname, '..');
const build = join(root, '.runtime', 'native-build');
const fixture = existsSync(join(build, 'Release', win ? 'openqq-fixture.exe' : 'openqq-fixture')) ? join(build, 'Release') : build;
const launcher = join(root, 'native', 'bin', win ? 'openqq-launch.exe' : 'openqq-launch');
const dll = join(root, 'native', 'bin', win ? 'openqq-bootstrap.dll' : 'openqq-bootstrap.so');
const host = join(fixture, win ? 'openqq-fixture.exe' : 'openqq-fixture');
const runtimeLib = join(fixture, win ? 'QQNT.dll' : 'QQNT.so');

function killFixture(pid) {
  if (!pid) return;
  if (win) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    return;
  }
  try { process.kill(Number(pid), 'SIGKILL'); } catch {}
}

test('native stdin serialization escapes source and rejects extra config lines', () => {
  const config = { executable: host, wrapper: runtimeLib, dll, payload: 'C:\\中文 path\\session.cjs', pipe: '\\\\.\\pipe\\fixture', token: 'fixture-only' };
  const lines = bootstrapInput(config).trimEnd().split('\n');
  assert.equal(lines.length, 4);
  const native = { startNative(value, exports) { assert.deepEqual(value, { pipe: config.pipe, token: config.token }); return exports; } };
  const global = { __openqq_exports: { valid: true } };
  const result = Function('require', 'globalThis', `return ${lines[3]}`)(path => { assert.equal(path, config.payload); return native; }, global);
  assert.deepEqual(result, { valid: true });
  assert.equal(Object.hasOwn(global, '__openqq_exports'), false);
  for (const token of ['bad\nline', 'bad\rline', 'bad\0line']) assert.throws(() => bootstrapInput({ ...config, token }));
});

const scenarios = [
  ['main', 0, 'escaped replacement'],
  ['worker', 0, 'escaped replacement'],
  ['original-error', 1, 'original exception preserved'],
  ['script-error', 1, 'script exception cleared'],
  ['bad-dll', 1, win ? 'original return' : null],
  ['cancel', 1, win ? 'original return' : null],
  ['exit', 1, null],
];
for (const [mode, expectedCode, expectedReturn] of scenarios) {
  test('C++ native bootstrap: ' + mode, { skip: !win && !linux, timeout: 45000 }, async t => {
    assert.ok(existsSync(host), 'run npm run build:native first');
    const output = join(build, 'evaluated-' + mode + '.txt');
    for (const path of [output, output + '.return']) rmSync(path, { force: true });
    const child = spawn(launcher, [], { windowsHide: true, env: { ...process.env, OPENQQ_FIXTURE_OUTPUT: output, OPENQQ_FIXTURE_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostics = '', cancelled = false;
    child.stderr.setEncoding('utf8').on('data', chunk => {
      diagnostics += chunk;
      if (mode === 'cancel' && !cancelled && diagnostics.includes('runtime_found')) { cancelled = true; child.stdin.end(); }
    });
    child.stdout.resume();
    child.stdin.on('error', () => {});
    t.after(() => {
      if (child.exitCode === null) child.stdin.end('stop\n');
      const pid = diagnostics.match(/"pid":(\d+)/)?.[1];
      killFixture(pid);
    });
    const badDll = join(build, win ? 'invalid.dll' : 'invalid.so');
    if (mode === 'bad-dll') writeFileSync(badDll, 'invalid fixture native module');
    child.stdin.write(bootstrapInput({ executable: host, wrapper: runtimeLib, dll: mode === 'bad-dll' ? badDll : dll,
      payload: join(root, 'native', 'session.cjs'), pipe: '\\\\.\\pipe\\openqq-fixture', token: 'fixture-only' }));
    const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); });
    assert.equal(code, expectedCode, diagnostics);
    const stages = diagnostics.trim().split('\n').filter(Boolean).map(line => JSON.parse(line.slice('[OpenQQ/native] '.length)));
    if (mode !== 'cancel' && !(linux && mode === 'bad-dll')) {
      assert.ok(stages.some(e => e.stage === 'addon_register' && e.name === 'wrapper' && !e.target), diagnostics);
      assert.ok(stages.some(e => e.stage === 'addon_register' && e.name === 'QQNT' && e.target), diagnostics);
    }
    if (expectedCode === 0) {
      assert.ok(stages.some(e => e.stage === 'bootstrapped'), diagnostics);
      assert.match(readFileSync(output, 'utf8'), /\.startNative\(/);
      assert.match(readFileSync(output, 'utf8'), /fixture-only/);
    } else assert.ok(stages.some(e => e.stage === 'error'), diagnostics);
    if (mode === 'exit') {
      // A crash after detaching still reports the exit code and where the bootstrap was.
      const pattern = win
        ? /exit code 0xC0000409 fail-fast.*stage: running the bootstrap script/
        : /exit code 77.*stage: running the bootstrap script/;
      assert.match(stages.find(e => e.stage === 'error').error, pattern, diagnostics);
      return;
    }
    if (expectedReturn === null) return;
    for (let attempt = 0; attempt < 40 && !existsSync(output + '.return'); attempt++) await delay(50);
    assert.equal(readFileSync(output + '.return', 'utf8'), expectedReturn, diagnostics);
  });
}

test('Linux native bootstrap intercepts main-executable qq_magic_napi_register during dlopen(.node)', { skip: !linux, timeout: 45000 }, async t => {
  const exeHost = join(fixture, 'openqq-fixture-exe');
  const addonNode = join(fixture, 'fixture-wrapper.node');
  assert.ok(existsSync(exeHost) && existsSync(addonNode), 'run npm run build:native first');
  const output = join(build, 'evaluated-linux-main-exe.txt');
  for (const path of [output, output + '.return']) rmSync(path, { force: true });
  const child = spawn(launcher, [], { env: { ...process.env, OPENQQ_FIXTURE_OUTPUT: output }, stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk; });
  child.stdout.resume();
  child.stdin.on('error', () => {});
  t.after(() => {
    if (child.exitCode === null) child.stdin.end('stop\n');
    const pid = diagnostics.match(/"pid":(\d+)/)?.[1];
    killFixture(pid);
  });
  child.stdin.write(bootstrapInput({ executable: exeHost, wrapper: addonNode, dll,
    payload: join(root, 'native', 'session.cjs'), pipe: '/tmp/openqq-fixture.sock', token: 'fixture-only' }));
  const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); });
  assert.equal(code, 0, diagnostics);
  const stages = diagnostics.trim().split('\n').filter(Boolean).map(line => JSON.parse(line.slice('[OpenQQ/native] '.length)));
  assert.ok(stages.some(e => e.stage === 'runtime_found'), diagnostics);
  assert.ok(stages.some(e => e.stage === 'addon_register' && e.name === 'wrapper' && !e.target), diagnostics);
  assert.ok(stages.some(e => e.stage === 'addon_register' && e.name === 'QQNT' && e.target), diagnostics);
  assert.ok(stages.some(e => e.stage === 'bootstrapped'), diagnostics);
  assert.match(readFileSync(output, 'utf8'), /\.startNative\(/);
  for (let attempt = 0; attempt < 40 && !existsSync(output + '.return'); attempt++) await delay(50);
  assert.equal(readFileSync(output + '.return', 'utf8'), 'escaped replacement', diagnostics);
});
