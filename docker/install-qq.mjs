import { createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const arch = (process.env.TARGETARCH || (process.arch === 'arm64' ? 'arm64' : 'amd64')).toLowerCase();
const explicitUrl = (process.env.QQ_DEB_URL || '').trim();
const outPath = process.argv[2] || '/tmp/linuxqq.deb';

function extractJsonObject(text) {
  const start = text.indexOf('{', text.indexOf('params'));
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Could not find JSON object in QQ download manifest');
  return JSON.parse(text.slice(start, end + 1));
}

async function resolveFromDownloadManifest() {
  const url = 'https://cdn-go.cn/qq-web/im.qq.com_new/latest/rainbow/linuxQQDownload.js';
  const res = await fetch(url, { headers: { 'User-Agent': 'OpenQQ-Docker-Builder' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const data = extractJsonObject(await res.text());
  const entry = arch === 'arm64' ? data.armDownloadUrl : data.x64DownloadUrl;
  const debUrl = entry?.deb || entry?.debUrl;
  if (typeof debUrl !== 'string' || !/^https?:\/\//.test(debUrl)) {
    throw new Error(`No .deb URL found for arch=${arch} in linuxQQDownload.js`);
  }
  return debUrl;
}

async function resolveFromPcConfig() {
  const url = 'https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json';
  const res = await fetch(url, { headers: { 'User-Agent': 'OpenQQ-Docker-Builder' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  const text = await res.text();
  const pattern = arch === 'arm64'
    ? /https:\/\/[^"'\s]+(?:arm64|aarch64)[^"'\s]*\.deb/i
    : /https:\/\/[^"'\s]+(?:amd64|x86_64|x64)[^"'\s]*\.deb/i;
  const match = text.match(pattern);
  if (!match) throw new Error(`No .deb URL found for arch=${arch} in pcConfig.json`);
  return match[0];
}

async function signUrlIfNeeded(rawUrl) {
  try {
    const head = await fetch(rawUrl, { method: 'HEAD', redirect: 'follow' });
    if (head.ok) return rawUrl;
  } catch { /* fall through to sign API */ }
  const signEndpoint = 'https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign';
  const res = await fetch(signEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://im.qq.com',
      Referer: 'https://im.qq.com/',
      'x-oidb': '{"uint32_command":"0x9b8e","uint32_service_type":1}',
    },
    body: JSON.stringify({ url: rawUrl }),
  });
  if (!res.ok) return rawUrl;
  const payload = await res.json().catch(() => null);
  return payload?.data?.url || rawUrl;
}

async function downloadDeb(url) {
  if (!/^https?:\/\//.test(url)) throw new Error('QQ_DEB_URL must use http:// or https://');
  console.log(`[OpenQQ/docker] Downloading Linux QQ (${arch}) from ${new URL(url).origin}...`);
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'OpenQQ-Docker-Builder' } });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(outPath));
  const info = await stat(outPath);
  if (info.size < 1024 * 1024) throw new Error(`Downloaded file too small (${info.size} bytes)`);
  const fh = await open(outPath, 'r');
  try {
    const magic = Buffer.alloc(8);
    await fh.read(magic, 0, 8, 0);
    if (magic.toString('ascii') !== '!<arch>\n') throw new Error('Downloaded file is not a valid Debian .deb archive');
  } finally {
    await fh.close();
  }
  console.log(`[OpenQQ/docker] Verified .deb (${(info.size / 1048576).toFixed(1)} MiB)`);
}

async function main() {
  let targetUrl = explicitUrl;
  if (!targetUrl) {
    // pcConfig.json tracks the current release; linuxQQDownload.js is a stale JSONP file (it still lists 3.2.9), so it is only a fallback.
    try {
      targetUrl = await resolveFromPcConfig();
    } catch (err) {
      console.warn(`[OpenQQ/docker] pcConfig lookup failed (${err.message}), trying fallback...`);
      targetUrl = await resolveFromDownloadManifest();
    }
    targetUrl = await signUrlIfNeeded(targetUrl);
  }
  await downloadDeb(targetUrl);
}

await main();
