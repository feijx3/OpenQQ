import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { basename, extname, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import common from '../native/common.cjs';

const { fail } = common;
const MiB = 1024 * 1024;
const defaultLimits = { image: 30 * MiB, record: 20 * MiB, video: 200 * MiB, file: 200 * MiB };
const mediaTypes = new Set(['image', 'record', 'video', 'file']);
// Optional encoder for turning WAV / other audio into SILK. Not a literal import, so bundlers leave it alone.
const silkPackage = 'silk-wasm';

// ---- address policy for downloads ---------------------------------------------------------------------------------
const blocked = new net.BlockList();
// 198.18.0.0/15 is deliberately not listed: proxies in "fake-ip" DNS mode (Clash and similar) answer every name with an address
// from it, so blocking it would stop every download for those users. It is a benchmarking range, not a private network.
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(address, prefix, 'ipv6');

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family) return true;
  const mapped = family === 6 && address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  // ::ffff:7f00:1 style (hex) mapped addresses
  const hex = family === 6 && address.toLowerCase().match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16), low = parseInt(hex[2], 16);
    return blocked.check(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, 'ipv4');
  }
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// ---- format sniffing ----------------------------------------------------------------------------------------------
export function imageInfo(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR') {
    return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && ['GIF87a', 'GIF89a'].includes(b.toString('latin1', 0, 6))) return { format: 'gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) { offset++; continue; }
      const marker = b[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { offset += 2; continue; }
      const length = b.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: 'jpeg', height: b.readUInt16BE(offset + 5), width: b.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    return null;
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { format: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') return { format: 'webp', width: 1 + (((b[22] & 0x3f) << 8) | b[21]), height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (chunk === 'VP8X') return { format: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return { format: 'bmp', width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  return null;
}

const silkHeader = Buffer.from('#!SILK_V3');
export function silkInfo(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let offset = b[0] === 0x02 ? 1 : 0;
  if (!b.subarray(offset, offset + silkHeader.length).equals(silkHeader)) return null;
  offset += silkHeader.length;
  let frames = 0;
  while (offset + 2 <= b.length) {
    const length = b.readUInt16LE(offset);
    if (length === 0xffff) break;
    offset += 2 + length;
    frames++;
  }
  return { frames, duration: Math.max(1, Math.round(frames * 0.02)) };
}

export function wavInfo(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
  let offset = 12, format;
  while (offset + 8 <= b.length) {
    const id = b.toString('latin1', offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= b.length) {
      format = { audioFormat: b.readUInt16LE(offset + 8), channels: b.readUInt16LE(offset + 10), sampleRate: b.readUInt32LE(offset + 12), bits: b.readUInt16LE(offset + 22) };
    } else if (id === 'data' && format) {
      const end = Math.min(b.length, offset + 8 + size);
      return { ...format, dataStart: offset + 8, dataEnd: end };
    }
    offset += 8 + size + (size & 1);
  }
  return null;
}

// Mono 16-bit PCM at `rate`, from an integer WAV. Linear interpolation is enough for speech.
export function wavToPcm(bytes, info, rate = 24000) {
  if (info.audioFormat !== 1 || info.bits !== 16 || !info.channels || !info.sampleRate) throw fail('WAV 仅支持 16 位 PCM');
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const frames = Math.floor((info.dataEnd - info.dataStart) / (2 * info.channels));
  if (frames < 1) throw fail('WAV 没有音频数据');
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < info.channels; c++) sum += b.readInt16LE(info.dataStart + (i * info.channels + c) * 2);
    mono[i] = sum / info.channels;
  }
  const count = Math.max(1, Math.round(frames * rate / info.sampleRate));
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const position = i * info.sampleRate / rate;
    const left = Math.min(frames - 1, Math.floor(position));
    const right = Math.min(frames - 1, left + 1);
    const value = mono[left] + (mono[right] - mono[left]) * (position - left);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), i * 2);
  }
  return out;
}

// ISO base media (MP4 / MOV): duration from mvhd, size from the first video track's tkhd. Only box headers are read
// from disk, because moov is often at the end of a large file.
export async function videoInfo(path) {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    const readBox = async offset => {
      if (offset + 8 > size) return null;
      await handle.read(header, 0, 16, offset);
      let length = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let head = 8;
      if (length === 1) { length = Number(header.readBigUInt64BE(8)); head = 16; }
      else if (length === 0) length = size - offset;
      if (length < head || offset + length > size) return null;
      return { type, offset, length, head };
    };
    const first = await readBox(0);
    if (first?.type !== 'ftyp') return null;
    const brand = Buffer.alloc(4);
    await handle.read(brand, 0, 4, first.offset + first.head);
    const format = brand.toString('latin1') === 'qt  ' ? 'mov' : 'mp4';
    let moov;
    for (let offset = 0; offset < size;) {
      const box = await readBox(offset);
      if (!box) return null;
      if (box.type === 'moov') { moov = box; break; }
      offset += box.length;
    }
    if (!moov || moov.length > 16 * MiB) return null;
    const body = Buffer.alloc(moov.length - moov.head);
    await handle.read(body, 0, body.length, moov.offset + moov.head);
    const children = (buffer, from = 0, to = buffer.length) => {
      const found = [];
      for (let offset = from; offset + 8 <= to;) {
        let length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        if (length === 0) length = to - offset;
        if (length < 8 || offset + length > to) break;
        found.push({ type, start: offset + 8, end: offset + length });
        offset += length;
      }
      return found;
    };
    let duration = 0, width = 0, height = 0;
    for (const box of children(body)) {
      if (box.type === 'mvhd') {
        const version = body[box.start];
        const timescale = body.readUInt32BE(box.start + (version === 1 ? 20 : 12));
        const value = version === 1 ? Number(body.readBigUInt64BE(box.start + 24)) : body.readUInt32BE(box.start + 16);
        if (timescale > 0) duration = value / timescale;
      }
      if (box.type !== 'trak') continue;
      let video = false, w = 0, h = 0;
      for (const inner of children(body, box.start, box.end)) {
        if (inner.type === 'tkhd') {
          const version = body[inner.start];
          const at = inner.start + (version === 1 ? 88 : 76);
          if (at + 8 <= inner.end) { w = body.readUInt32BE(at) / 65536; h = body.readUInt32BE(at + 4) / 65536; }
        }
        if (inner.type === 'mdia') {
          for (const media of children(body, inner.start, inner.end)) {
            if (media.type === 'hdlr' && media.start + 12 <= media.end) video = body.toString('latin1', media.start + 8, media.start + 12) === 'vide';
          }
        }
      }
      if (video && !width) { width = Math.round(w); height = Math.round(h); }
    }
    if (!width || !height || !(duration > 0)) return null;
    return { format, width, height, duration: Math.max(1, Math.round(duration)) };
  } finally { await handle.close(); }
}

// ---- helpers ------------------------------------------------------------------------------------------------------
export function safeName(value, fallback) {
  const name = String(value ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[. ]+$/, '').slice(0, 100);
  return name && name !== '.' && name !== '..' ? name : fallback;
}

function localPathFrom(source) {
  if (/^(?:\\\\|\/\/)/.test(source)) throw fail('不允许网络路径或设备路径');
  if (!isAbsolute(source) || !/^(?:[A-Za-z]:[\\/]|\/)/.test(source)) throw fail('file 必须是绝对路径、file:// 地址、base64:// 数据或 http(s) 链接');
  return source;
}

function runProcess(command, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('转码超时')); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.trim().split('\n').pop()}`)); });
  });
}

// ---- the preparer -------------------------------------------------------------------------------------------------
export function createMediaPreparer({ dir, allowPrivate = process.env.OPENQQ_MEDIA_ALLOW_PRIVATE === '1', limits = {}, timeoutMs = 30000,
  ffmpeg = process.env.OPENQQ_FFMPEG || 'ffmpeg', loadSilk = () => import(silkPackage) } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('媒体临时目录必须指定');
  const max = { ...defaultLimits, ...limits };

  async function tempFile(extension = '') {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return join(dir, randomBytes(12).toString('hex') + extension);
  }

  function download(first, kind, track) {
    const limit = max[kind];
    return new Promise((resolveOuter, rejectOuter) => {
      let hops = 0, current, deadline;
      const resolve = value => { clearTimeout(deadline); resolveOuter(value); };
      const reject = error => { clearTimeout(deadline); rejectOuter(error); };
      const guarded = (hostname, options, callback) => lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) { callback(error); return; }
        if (!allowPrivate && addresses.some(item => isBlockedAddress(item.address))) { callback(Object.assign(new Error('下载地址指向本机或内网'), { retcode: 1400 })); return; }
        if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
      });
      const get = url => {
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { reject(fail('下载地址必须是不带账号的 http(s) 链接')); return; }
        const literal = url.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(literal) && !allowPrivate && isBlockedAddress(literal)) { reject(fail('下载地址指向本机或内网')); return; }
        const request = (url.protocol === 'https:' ? https : http).get(url, { lookup: guarded, timeout: timeoutMs, headers: { 'User-Agent': 'OpenQQ', Accept: '*/*' } }, response => {
          handle(url, response).catch(error => reject(error.retcode ? error : fail('下载失败：' + error.message)));
        });
        current = request;
        request.once('timeout', () => request.destroy(fail('下载超时')));
        request.once('error', error => reject(error.retcode ? error : fail('下载失败：' + (error.code ?? error.message))));
      };
      const handle = async (url, response) => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (++hops > 3) throw fail('下载重定向次数过多');
          let next;
          try { next = new URL(response.headers.location, url); } catch { throw fail('下载重定向地址无效'); }
          get(next);
          return;
        }
        if (status !== 200) { response.resume(); throw fail(`下载失败：HTTP ${status}`); }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) { response.resume(); throw fail(`文件超过 ${limit / MiB} MiB 上限`); }
        const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(response.headers['content-disposition'] ?? ''));
        let name;
        try { name = disposition ? decodeURIComponent(disposition[1]) : basename(decodeURIComponent(url.pathname)); } catch { name = basename(url.pathname); }
        const path = await tempFile(extname(name).slice(0, 12).replace(/[^.\w]/g, ''));
        track(path);
        let received = 0;
        const out = createWriteStream(path, { mode: 0o600 });
        response.on('data', chunk => {
          received += chunk.length;
          if (received > limit) { response.destroy(fail(`文件超过 ${limit / MiB} MiB 上限`)); out.destroy(); }
        });
        response.once('error', error => { out.destroy(); reject(error.retcode ? error : fail('下载中断：' + error.message)); });
        out.once('error', reject);
        out.once('finish', () => resolve({ path, name }));
        response.pipe(out);
      };
      deadline = setTimeout(() => { current?.destroy(); reject(fail('下载超时')); }, timeoutMs * 3);
      try { get(new URL(first)); } catch { reject(fail('下载地址无效')); }
    });
  }

  // Resolves one `file` value into a regular local file. Temporary files are reported through `track` for cleanup.
  async function resolveSource(value, kind, track) {
    if (typeof value !== 'string' || !value.trim()) throw fail(`${kind} 段缺少 file`);
    const source = value.trim();
    const limit = max[kind];
    const dataUri = source.match(/^data:[^;,]+;base64,([\s\S]+)$/i);
    if (source.startsWith('base64://') || dataUri) {
      const text = (dataUri ? dataUri[1] : source.slice(9)).replace(/\s+/g, '');
      if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) throw fail('base64 数据无效');
      if (text.length / 4 * 3 > limit + 3) throw fail(`文件超过 ${limit / MiB} MiB 上限`);
      const path = await tempFile();
      track(path);
      await writeFile(path, Buffer.from(text, 'base64'), { mode: 0o600 });
      return { path, name: '' };
    }
    if (/^https?:\/\//i.test(source)) return download(source, kind, track);
    let path;
    if (/^file:/i.test(source)) {
      let url;
      try { url = new URL(source); } catch { throw fail('file:// 地址无效'); }
      if (url.host && url.host !== 'localhost') throw fail('不允许网络路径');
      try { path = fileURLToPath(url); } catch { throw fail('file:// 地址无效'); }
    } else path = source;
    path = localPathFrom(path);
    let info;
    try { info = await stat(path); } catch { throw fail('找不到文件：' + path); }
    if (!info.isFile()) throw fail('file 不是普通文件');
    return { path, name: basename(path) };
  }

  async function sizeChecked(path, kind) {
    const { size } = await stat(path);
    if (size < 1) throw fail('文件为空');
    if (size > max[kind]) throw fail(`文件超过 ${max[kind] / MiB} MiB 上限`);
    return size;
  }

  async function readHead(path, length) {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }

  async function image(data, track) {
    const source = await resolveSource(data.file ?? data.url, 'image', track);
    const size = await sizeChecked(source.path, 'image');
    const info = imageInfo(await readHead(source.path, MiB));
    if (!info || !(info.width > 0) || !(info.height > 0)) throw fail('不是支持的图片（png、jpeg、gif、webp、bmp）');
    const extension = info.format === 'jpeg' ? '.jpg' : '.' + info.format;
    const name = safeName(data.name ?? source.name, 'image' + extension);
    return { kind: 'image', path: source.path, name: extname(name) ? name : name + extension, size, format: info.format, width: info.width, height: info.height };
  }

  async function silk() {
    try { return await loadSilk(); }
    catch { throw fail('转换语音需要安装可选依赖 silk-wasm（npm install silk-wasm），或直接提供 SILK 格式语音', 1400); }
  }

  async function record(data, track) {
    const source = await resolveSource(data.file ?? data.url, 'record', track);
    await sizeChecked(source.path, 'record');
    const bytes = await readHead(source.path, max.record);
    let path = source.path;
    let info = silkInfo(bytes);
    if (!info) {
      let pcm;
      const wav = wavInfo(bytes);
      if (wav) pcm = wavToPcm(bytes, wav);
      else {
        const output = await tempFile('.pcm');
        track(output);
        try { await runProcess(ffmpeg, ['-v', 'error', '-i', source.path, '-f', 's16le', '-ar', '24000', '-ac', '1', '-y', output]); }
        catch (error) {
          if (error.code === 'ENOENT') throw fail('该语音不是 SILK 或 WAV；转换其他格式需要在本机安装 ffmpeg（或设置 OPENQQ_FFMPEG）');
          throw fail('语音转码失败：' + error.message);
        }
        pcm = await readHead(output, max.record * 2);
      }
      const encoded = await (await silk()).encode(pcm, 24000);
      path = await tempFile('.slk');
      track(path);
      await writeFile(path, encoded.data, { mode: 0o600 });
      info = silkInfo(encoded.data) ?? { duration: Math.max(1, Math.round(encoded.duration / 1000)) };
    }
    return { kind: 'record', path, name: safeName(source.name, 'voice') + '.slk', size: await sizeChecked(path, 'record'), duration: info.duration };
  }

  async function video(data, track) {
    const source = await resolveSource(data.file ?? data.url, 'video', track);
    const size = await sizeChecked(source.path, 'video');
    const info = await videoInfo(source.path).catch(() => null);
    if (!info) throw fail('不是可识别的 MP4/MOV 视频（目前只支持这两种封装）');
    let thumb;
    if (data.thumb || data.cover) thumb = await image({ file: data.thumb ?? data.cover }, track);
    else {
      const output = await tempFile('.jpg');
      track(output);
      try { await runProcess(ffmpeg, ['-v', 'error', '-i', source.path, '-frames:v', '1', '-y', output]); }
      catch (error) {
        if (error.code === 'ENOENT') throw fail('发送视频需要封面：请提供 thumb 参数（图片），或在本机安装 ffmpeg（或设置 OPENQQ_FFMPEG）');
        throw fail('截取视频封面失败：' + error.message);
      }
      thumb = await image({ file: output }, track);
    }
    const name = safeName(data.name ?? source.name, 'video.' + info.format);
    return { kind: 'video', path: source.path, name: extname(name) ? name : name + '.' + info.format, size, format: info.format, width: info.width, height: info.height,
      duration: info.duration, thumb: { path: thumb.path, size: thumb.size, format: thumb.format, width: thumb.width, height: thumb.height } };
  }

  async function file(data, track) {
    const source = await resolveSource(data.file ?? data.url, 'file', track);
    const size = await sizeChecked(source.path, 'file');
    return { kind: 'file', path: source.path, name: safeName(data.name ?? source.name, 'file'), size };
  }

  const builders = { image, record, video, file };
  return {
    // Returns { params, release }. Incoming `openqq_media` fields are always discarded: only this function may set them.
    async prepare(params) {
      const created = [];
      const track = path => created.push(path);
      const release = async () => { await Promise.all(created.splice(0).map(path => rm(path, { force: true }).catch(() => {}))); };
      if (!Array.isArray(params?.message)) return { params, release };
      try {
        let count = 0;
        const message = [];
        for (const segment of params.message) {
          if (!segment || typeof segment !== 'object' || typeof segment.data !== 'object' || segment.data === null || Array.isArray(segment.data)) { message.push(segment); continue; }
          const { openqq_media: ignored, ...data } = segment.data;
          if (!mediaTypes.has(segment.type)) { message.push({ ...segment, data }); continue; }
          if (++count > 20) throw fail('一条消息最多包含 20 个媒体段');
          const prepared = await builders[segment.type](data, track);
          // Native actions only consume openqq_media (and summary.slice(0, 64) for images); drop everything else so large base64:// payloads or unexpected keys never enter the 1 MiB IPC frame.
          const summary = segment.type === 'image' && typeof data.summary === 'string' ? { summary: data.summary.slice(0, 64) } : {};
          message.push({ ...segment, data: { ...summary, openqq_media: prepared } });
        }
        return { params: { ...params, message }, release };
      } catch (error) { await release(); throw error; }
    },
    // Best-effort removal of leftovers from an earlier crashed run.
    async sweep(olderThanMs = 3600000) {
      let names = [];
      try { names = await readdir(dir); } catch { return; }
      for (const name of names) {
        const path = join(dir, name);
        try { if (Date.now() - (await stat(path)).mtimeMs > olderThanMs) await rm(path, { force: true }); } catch { /* ignore */ }
      }
    },
  };
}
