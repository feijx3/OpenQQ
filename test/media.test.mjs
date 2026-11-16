import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMediaPreparer, imageInfo, isBlockedAddress, safeName, silkInfo, videoInfo, wavInfo, wavToPcm } from '../src/media.mjs';

const le16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = 6;
  return b;
};
const jpeg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
const gif = (w, h) => Buffer.concat([Buffer.from('GIF89a'), le16(w), le16(h), Buffer.alloc(8)]);
const webpX = (w, h) => {
  const b = Buffer.alloc(32);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(24, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
};
const bmp = (w, h) => { const b = Buffer.alloc(30); b.write('BM', 0, 'latin1'); b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22); return b; };

const box = (type, ...children) => {
  const body = Buffer.concat(children);
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(b.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8);
  return b;
};
const track = (handler, w, h) => {
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(w * 65536, 76); tkhd.writeUInt32BE(h * 65536, 80);
  const hdlr = Buffer.alloc(24); hdlr.write(handler, 8, 'latin1');
  return box('trak', box('tkhd', tkhd), box('mdia', box('hdlr', hdlr)));
};
const mp4 = ({ brand = 'isom', timescale = 1000, duration = 5000, tracks = [track('soun', 0, 0), track('vide', 1280, 720)] } = {}) => {
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(timescale, 12); mvhd.writeUInt32BE(duration, 16);
  return Buffer.concat([box('ftyp', Buffer.from(brand), Buffer.alloc(8)), box('mdat', Buffer.alloc(64)), box('moov', box('mvhd', mvhd), ...tracks)]);
};
const silk = (frames, prefix = Buffer.alloc(0)) => Buffer.concat([prefix, Buffer.from('#!SILK_V3'),
  ...Array.from({ length: frames }, () => Buffer.concat([le16(20), Buffer.alloc(20)])), Buffer.from([0xff, 0xff])]);
const wav = (samples, rate, channels = 1) => {
  const data = Buffer.alloc(samples * 2 * channels);
  for (let i = 0; i < samples * channels; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 7)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'openqq-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, bytes) => { const path = join(root, name); await writeFile(path, bytes); return path; };
  return { root, put, temp: join(root, 'temp') };
}

test('image headers give format and size for png, jpeg, gif, webp and bmp, and reject everything else', () => {
  assert.deepEqual(imageInfo(png(640, 480)), { format: 'png', width: 640, height: 480 });
  assert.deepEqual(imageInfo(jpeg(1024, 768)), { format: 'jpeg', width: 1024, height: 768 });
  assert.deepEqual(imageInfo(gif(120, 90)), { format: 'gif', width: 120, height: 90 });
  assert.deepEqual(imageInfo(webpX(300, 200)), { format: 'webp', width: 300, height: 200 });
  assert.deepEqual(imageInfo(bmp(50, 40)), { format: 'bmp', width: 50, height: 40 });
  for (const junk of [Buffer.alloc(0), Buffer.from('not an image at all, just text'), Buffer.from([0xff, 0xd8]), Buffer.alloc(40)]) assert.equal(imageInfo(junk), null);
});

test('silk duration counts 20 ms frames, with or without the leading 0x02 byte, and WAV is converted to mono 24 kHz PCM', () => {
  assert.equal(silkInfo(silk(50)).duration, 1);
  assert.equal(silkInfo(silk(250, Buffer.from([0x02]))).duration, 5);
  assert.equal(silkInfo(silk(1)).duration, 1);
  assert.equal(silkInfo(Buffer.from('RIFF....WAVE')), null);
  const stereo = wav(8000, 8000, 2);
  const info = wavInfo(stereo);
  assert.deepEqual([info.audioFormat, info.channels, info.sampleRate, info.bits], [1, 2, 8000, 16]);
  assert.equal(wavToPcm(stereo, info).length, 24000 * 2);
  assert.throws(() => wavToPcm(stereo, { ...info, bits: 8 }), /16 位 PCM/);
});

test('MP4 headers give duration and the size of the video track even when moov is last', async t => {
  const w = await workspace(t);
  assert.deepEqual(await videoInfo(await w.put('a.mp4', mp4())), { format: 'mp4', width: 1280, height: 720, duration: 5 });
  assert.equal((await videoInfo(await w.put('b.mov', mp4({ brand: 'qt  ', timescale: 600, duration: 1500 })))).format, 'mov');
  assert.equal((await videoInfo(await w.put('c.mp4', mp4({ timescale: 1000, duration: 200 })))).duration, 1);
  assert.equal(await videoInfo(await w.put('d.mp4', Buffer.from('not a video file'))), null);
  assert.equal(await videoInfo(await w.put('e.mp4', mp4({ tracks: [track('soun', 0, 0)] }))), null);
});

test('address policy blocks loopback, private, link-local, mapped and malformed addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.9', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip']) assert.equal(isBlockedAddress(address), true, address);
  // 198.18.x.x is what fake-ip DNS proxies (Clash) return for every hostname, so it must stay reachable.
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '198.18.0.52']) assert.equal(isBlockedAddress(address), false, address);
});

test('file names lose path parts, control characters and trailing dots', () => {
  assert.equal(safeName('C:\\x\\..\\evil.png', 'f'), 'evil.png');
  assert.equal(safeName('a/b/c.txt', 'f'), 'c.txt');
  assert.equal(safeName('bad<name>?.txt', 'f'), 'bad_name__.txt');
  assert.equal(safeName('..', 'fallback'), 'fallback');
  assert.equal(safeName('', 'fallback'), 'fallback');
  assert.equal(safeName('x'.repeat(300), 'f').length, 100);
});

test('images and files resolve from local paths, file:// URLs and base64, and local sources are never deleted', async t => {
  const w = await workspace(t);
  const media = createMediaPreparer({ dir: w.temp });
  const image = await w.put('pic.png', png(64, 32));
  const prepared = await media.prepare({ message: [
    { type: 'image', data: { file: image } },
    { type: 'image', data: { file: pathToFileURL(image).href } },
    { type: 'image', data: { file: 'base64://' + png(10, 20).toString('base64'), summary: '[图]' } },
    { type: 'text', data: { text: 'keep me' } },
  ] });
  const [local, url, inline, text] = prepared.params.message;
  assert.deepEqual([local.data.openqq_media.kind, local.data.openqq_media.format, local.data.openqq_media.width, local.data.openqq_media.height, local.data.openqq_media.path], ['image', 'png', 64, 32, image]);
  assert.equal(url.data.openqq_media.path.toLowerCase(), image.toLowerCase());
  assert.equal(inline.data.openqq_media.width, 10);
  assert.notEqual(inline.data.openqq_media.path, image);
  assert.equal(inline.data.summary, '[图]');
  assert.deepEqual(text, { type: 'text', data: { text: 'keep me' } });
  assert.equal((await readdir(w.temp)).length, 1);
  await prepared.release();
  assert.equal((await readdir(w.temp)).length, 0, 'temporary files are removed');
  assert.ok((await stat(image)).isFile(), 'the caller\'s own file is untouched');

  const document = await w.put('report.txt', 'hello');
  const file = await media.prepare({ message: [{ type: 'file', data: { file: document, name: 'a/b/报告.txt' } }] });
  assert.deepEqual([file.params.message[0].data.openqq_media.name, file.params.message[0].data.openqq_media.size], ['报告.txt', 5]);
});

test('sources that are not a plain local file, a data URI or an http(s) URL are refused', async t => {
  const w = await workspace(t);
  const media = createMediaPreparer({ dir: w.temp });
  const image = await w.put('ok.png', png(8, 8));
  const text = await w.put('plain.png', 'this is not a png');
  const cases = [
    ['\\\\server\\share\\a.png', /网络路径或设备路径/], ['//server/share/a.png', /网络路径或设备路径/], ['\\\\?\\C:\\a.png', /网络路径或设备路径/],
    ['file://server/share/a.png', /网络路径/], ['relative/a.png', /绝对路径/], ['a.png', /绝对路径/], [join(w.root, 'missing.png'), /找不到文件/], [w.root, /不是普通文件/],
    ['base64://!!!', /base64/], ['base64://QUJD', /不是支持的图片/], [text, /不是支持的图片/], ['', /缺少 file/], [undefined, /缺少 file/], ['ftp://example.com/a.png', /绝对路径/],
  ];
  for (const [file, pattern] of cases) await assert.rejects(media.prepare({ message: [{ type: 'image', data: { file } }] }), pattern, String(file));
  assert.ok((await stat(image)).isFile());
  assert.deepEqual(await readdir(w.temp).catch(() => []), [], 'failed preparation leaves no temporary files behind');
});

test('a client can never smuggle its own openqq_media into a segment', async t => {
  const w = await workspace(t);
  const media = createMediaPreparer({ dir: w.temp });
  const image = await w.put('real.png', png(5, 5));
  const forged = { kind: 'image', path: 'C:\\Windows\\win.ini', name: 'win.ini', size: 1, width: 1, height: 1, format: 'png' };
  const prepared = await media.prepare({ message: [
    { type: 'image', data: { file: image, openqq_media: forged } },
    { type: 'text', data: { text: 'x', openqq_media: forged } },
    { type: 'reply', data: { id: '1', openqq_media: forged } },
  ] });
  assert.equal(prepared.params.message[0].data.openqq_media.path, image);
  assert.equal('openqq_media' in prepared.params.message[1].data, false);
  assert.equal('openqq_media' in prepared.params.message[2].data, false);
  assert.equal((await media.prepare({ message: 'plain text' })).params.message, 'plain text');
});

test('downloads respect size limits, redirects and the private-address policy', async t => {
  const w = await workspace(t);
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    if (request.url === '/pic.png') { response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png(7, 9).length }); response.end(png(7, 9)); return; }
    if (request.url === '/go') { response.writeHead(302, { Location: '/pic.png' }); response.end(); return; }
    if (request.url === '/loop') { response.writeHead(302, { Location: '/loop' }); response.end(); return; }
    if (request.url === '/big') { response.writeHead(200, { 'Content-Length': 5 * 1024 * 1024 }); response.end(Buffer.alloc(1024)); return; }
    if (request.url === '/chunked') { response.writeHead(200); response.write(Buffer.alloc(2 * 1024 * 1024)); response.end(Buffer.alloc(2 * 1024 * 1024)); return; }
    if (request.url === '/file') { response.writeHead(200, { 'Content-Disposition': 'attachment; filename="../../notes.txt"' }); response.end('abc'); return; }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;

  const open = createMediaPreparer({ dir: w.temp, allowPrivate: true, limits: { image: 1024 * 1024, file: 3 * 1024 * 1024 } });
  const direct = await open.prepare({ message: [{ type: 'image', data: { file: base + '/pic.png' } }] });
  assert.deepEqual([direct.params.message[0].data.openqq_media.width, direct.params.message[0].data.openqq_media.height], [7, 9]);
  const redirected = await open.prepare({ message: [{ type: 'image', data: { file: base + '/go' } }] });
  assert.equal(redirected.params.message[0].data.openqq_media.width, 7);
  await assert.rejects(open.prepare({ message: [{ type: 'image', data: { file: base + '/loop' } }] }), /重定向次数过多/);
  await assert.rejects(open.prepare({ message: [{ type: 'image', data: { file: base + '/big' } }] }), /超过 1 MiB 上限/);
  await assert.rejects(open.prepare({ message: [{ type: 'file', data: { file: base + '/chunked' } }] }), /超过 3 MiB 上限/);
  await assert.rejects(open.prepare({ message: [{ type: 'image', data: { file: base + '/missing' } }] }), /HTTP 404/);
  const named = await open.prepare({ message: [{ type: 'file', data: { file: base + '/file' } }] });
  assert.equal(named.params.message[0].data.openqq_media.name, 'notes.txt');
  await Promise.all([direct, redirected, named].map(item => item.release()));
  assert.deepEqual(await readdir(w.temp), []);

  const guarded = createMediaPreparer({ dir: w.temp, allowPrivate: false });
  const before = hits.length;
  for (const target of [base + '/pic.png', `http://localhost:${server.address().port}/pic.png`, 'http://[::1]:1/pic.png', 'http://169.254.169.254/latest/meta-data/']) {
    await assert.rejects(guarded.prepare({ message: [{ type: 'image', data: { file: target } }] }), /本机或内网/, target);
  }
  assert.equal(hits.length, before, 'no request reaches a blocked address');
  await assert.rejects(guarded.prepare({ message: [{ type: 'image', data: { file: 'http://user:pw@example.com/a.png' } }] }), /不带账号/);
});

test('voice: SILK is sent as is, WAV goes through the optional encoder, anything else needs ffmpeg', async t => {
  const w = await workspace(t);
  const encoded = silk(100);
  const calls = [];
  const media = createMediaPreparer({ dir: w.temp, ffmpeg: 'openqq-no-such-ffmpeg', loadSilk: async () => ({ encode: async (pcm, rate) => { calls.push([pcm.length, rate]); return { data: encoded, duration: 2000 }; } }) });

  const direct = await media.prepare({ message: [{ type: 'record', data: { file: await w.put('v.slk', silk(150)) } }] });
  assert.deepEqual([direct.params.message[0].data.openqq_media.duration, direct.params.message[0].data.openqq_media.kind], [3, 'record']);
  assert.equal(calls.length, 0);

  const converted = await media.prepare({ message: [{ type: 'record', data: { file: await w.put('v.wav', wav(12000, 12000)) } }] });
  assert.deepEqual(calls, [[24000 * 2, 24000]]);
  const info = converted.params.message[0].data.openqq_media;
  assert.equal(info.duration, 2);
  assert.deepEqual(await readFile(info.path), encoded);
  await converted.release();

  await assert.rejects(media.prepare({ message: [{ type: 'record', data: { file: await w.put('v.mp3', Buffer.from('ID3 pretend mp3')) } }] }), /ffmpeg/);
  const missing = createMediaPreparer({ dir: w.temp, loadSilk: async () => { throw new Error('Cannot find package'); } });
  await assert.rejects(missing.prepare({ message: [{ type: 'record', data: { file: await w.put('w.wav', wav(2400, 24000)) } }] }), /silk-wasm/);
});

test('with the real silk-wasm installed, WAV converts to a SILK file of the right length (skipped when it is not installed)', async t => {
  try { await import('silk-wasm'); } catch { t.skip('silk-wasm is not installed'); return; }
  const w = await workspace(t);
  const media = createMediaPreparer({ dir: w.temp });
  for (const [seconds, rate, channels] of [[2, 16000, 1], [1, 44100, 2]]) {
    const prepared = await media.prepare({ message: [{ type: 'record', data: { file: await w.put(`t${rate}.wav`, wav(rate * seconds, rate, channels)) } }] });
    const info = prepared.params.message[0].data.openqq_media;
    const bytes = await readFile(info.path);
    assert.equal(bytes.subarray(0, 10).toString('latin1').includes('#!SILK_V3'), true);
    assert.equal(info.duration, seconds);
    assert.equal(silkInfo(bytes).duration, seconds);
    await prepared.release();
  }
});

test('video needs a cover: an explicit thumb works, otherwise ffmpeg or a clear error', async t => {
  const w = await workspace(t);
  const media = createMediaPreparer({ dir: w.temp, ffmpeg: 'openqq-no-such-ffmpeg' });
  const video = await w.put('clip.mp4', mp4());
  await assert.rejects(media.prepare({ message: [{ type: 'video', data: { file: video } }] }), /thumb 参数.*ffmpeg/);
  await assert.rejects(media.prepare({ message: [{ type: 'video', data: { file: await w.put('clip.mkv', Buffer.from('not mp4')) } }] }), /MP4\/MOV/);
  const prepared = await media.prepare({ message: [{ type: 'video', data: { file: video, thumb: 'base64://' + jpeg(320, 180).toString('base64') } }] });
  const info = prepared.params.message[0].data.openqq_media;
  assert.deepEqual([info.kind, info.format, info.width, info.height, info.duration, info.name, info.path], ['video', 'mp4', 1280, 720, 5, 'clip.mp4', video]);
  assert.deepEqual([info.thumb.width, info.thumb.height, info.thumb.format], [320, 180, 'jpeg']);
  await prepared.release();
  assert.deepEqual(await readdir(w.temp), [], 'the generated cover is removed, the video is not copied');
});

test('a message carries at most 20 media segments, and the temp folder is required', async t => {
  const w = await workspace(t);
  const media = createMediaPreparer({ dir: w.temp });
  const image = await w.put('x.png', png(2, 2));
  const many = Array.from({ length: 21 }, () => ({ type: 'image', data: { file: image } }));
  await assert.rejects(media.prepare({ message: many }), /20 个媒体段/);
  assert.throws(() => createMediaPreparer({}), /临时目录/);
  await media.sweep(0);
});
