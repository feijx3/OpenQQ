// download_file 的 SSRF 防护分两层，这里各覆盖一条：
//   · assertPublicHttpUrl 是同步的字面检查（validateAction 阶段就能拒）；
//   · assertHostResolves 是异步的 DNS 判定（执行侧、发请求前调）。
// 单看字面检查是不够的：`127.0.0.1.nip.io` 这种公共泛解析域名，字面上完全是公网主机名，
// 只有解析之后才知道它指向内网 —— 那正是 review 指出的绕过方式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const actions = require('../native/actions.cjs');

test('literal private targets are rejected before any DNS lookup', () => {
  const rejected = [
    'http://127.0.0.1:3999/panel',        // loopback
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://10.0.0.1/',                   // RFC1918
    'http://192.168.1.1/',                // RFC1918
    'http://[::1]/',                      // IPv6 loopback
    'http://localhost/',                  // hostname
    'http://localhost.localdomain/',      // hostname variant
    'http://service.internal/',           // hostname suffix
  ];
  for (const url of rejected) {
    assert.throws(() => actions.assertPublicHttpUrl(url), /拒绝/, `应该拒绝 ${url}`);
  }
});

test('urls carrying credentials are rejected', () => {
  assert.throws(() => actions.assertPublicHttpUrl('http://user:pass@example.com/'), /账号密码/);
});

test('non-http schemes are rejected', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://127.0.0.1:6379/']) {
    assert.throws(() => actions.assertPublicHttpUrl(url), /http/, `应该拒绝 ${url}`);
  }
});

test('a public-looking host that resolves to loopback is rejected by the DNS layer', async () => {
  // nip.io 把任意 IP 编进主机名并原样解析回来，所以这个主机名字面上完全看不出内网。
  // 需要联网解析；离线时 lookup 会失败，同样被拒（下面那条断言对两种结果都成立）。
  await assert.rejects(
    () => actions.assertHostResolves('http://127.0.0.1.nip.io/'),
    /拒绝内网|无法解析|解析不到/,
  );
});

test('a host that cannot be resolved is rejected rather than allowed through', async () => {
  // .invalid 是 RFC 2606 保留的、保证不存在的顶级域：没有任何一种情况下它该被放行。
  await assert.rejects(
    () => actions.assertHostResolves('http://openqq-download-check.invalid/'),
    /无法解析|解析不到|拒绝/,
  );
});

test('literal addresses skip the DNS layer (already decided synchronously)', async () => {
  // 字面公网 IP 不该因为 DNS 层再跑一次就失败；它上面已经判过了。
  await actions.assertHostResolves('http://93.184.216.34/');
});
