import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

// QQ builds this project has been run against on a real client (launch, login, messages).
export const verifiedVersions = ['9.9.33-52230', '9.9.37-54395'];
const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const requiredNapiExports = [
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

export function readFuses(bytes) {
  const start = bytes.indexOf(sentinel);
  if (start < 0) throw new Error('未找到 Electron fuse 标记');
  const offset = start + sentinel.length;
  if (bytes[offset] !== 1 || bytes[offset + 1] < 4 || offset + 2 + bytes[offset + 1] > bytes.length) {
    throw new Error('Electron fuse 格式不受支持');
  }
  const wire = bytes.subarray(offset + 2, offset + 2 + bytes[offset + 1]).toString('ascii');
  if (!/^[01r]+$/.test(wire)) throw new Error('Electron fuse 数据无效');
  return { wire, runAsNode: wire[0] === '1', nodeOptions: wire[2] === '1', nodeCliInspect: wire[3] === '1' };
}

export function readPE64Info(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
    return { valid: false, x64: false, exports: new Set() };
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 24 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    return { valid: false, x64: false, exports: new Set() };
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  const numSections = bytes.readUInt16LE(peOffset + 6);
  const optSize = bytes.readUInt16LE(peOffset + 20);
  const optOffset = peOffset + 24;
  if (machine !== 0x8664 || optOffset + optSize > bytes.length || optSize < 120 || bytes.readUInt16LE(optOffset) !== 0x20b) {
    return { valid: true, x64: false, exports: new Set() };
  }
  const numDirs = bytes.readUInt32LE(optOffset + 108);
  const exportRva = numDirs >= 1 ? bytes.readUInt32LE(optOffset + 112) : 0;
  const exportSize = numDirs >= 1 ? bytes.readUInt32LE(optOffset + 116) : 0;
  const sectionsOffset = optOffset + optSize;
  const sections = [];
  for (let i = 0; i < numSections && sectionsOffset + (i + 1) * 40 <= bytes.length; i++) {
    const base = sectionsOffset + i * 40;
    sections.push({
      virtualSize: bytes.readUInt32LE(base + 8),
      virtualAddress: bytes.readUInt32LE(base + 12),
      rawSize: bytes.readUInt32LE(base + 16),
      rawPtr: bytes.readUInt32LE(base + 20),
    });
  }
  const rvaToOffset = rva => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        const delta = rva - section.virtualAddress;
        if (delta >= section.rawSize) return -1;
        const offset = section.rawPtr + delta;
        return offset < bytes.length ? offset : -1;
      }
    }
    return -1;
  };
  const exports = new Set();
  if (exportRva > 0 && exportSize > 0) {
    const dirOffset = rvaToOffset(exportRva);
    if (dirOffset >= 0 && dirOffset + 40 <= bytes.length) {
      const count = Math.min(bytes.readUInt32LE(dirOffset + 24), 200000);
      const namesOffset = rvaToOffset(bytes.readUInt32LE(dirOffset + 32));
      if (namesOffset >= 0 && namesOffset + count * 4 <= bytes.length) {
        for (let i = 0; i < count; i++) {
          const nameOffset = rvaToOffset(bytes.readUInt32LE(namesOffset + i * 4));
          if (nameOffset < 0) continue;
          const end = bytes.indexOf(0, nameOffset);
          const limit = end >= 0 ? Math.min(end, nameOffset + 256) : Math.min(bytes.length, nameOffset + 256);
          exports.add(bytes.subarray(nameOffset, limit).toString('ascii'));
        }
      }
    }
  }
  return { valid: true, x64: true, exports };
}

export function readELF64Info(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) {
    return { valid: false, x64: false, arch: null, exports: new Set() };
  }
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    return { valid: true, x64: false, arch: null, exports: new Set() };
  }
  const type = bytes.readUInt16LE(16);
  const machine = bytes.readUInt16LE(18);
  if (type !== 2 && type !== 3) {
    return { valid: true, x64: false, arch: null, exports: new Set() };
  }
  const arch = machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : null;
  if (!arch) {
    return { valid: true, x64: false, arch: null, exports: new Set() };
  }
  const shoff = Number(bytes.readBigUInt64LE(40));
  const shentsize = bytes.readUInt16LE(58);
  const shnum = bytes.readUInt16LE(60);
  const exports = new Set();
  if (Number.isSafeInteger(shoff) && shoff > 0 && shentsize >= 64 && shnum > 0 && shnum <= 65535 && shoff + shnum * shentsize <= bytes.length) {
    const sections = [];
    for (let i = 0; i < shnum; i++) {
      const base = shoff + i * shentsize;
      sections.push({
        type: bytes.readUInt32LE(base + 4),
        offset: Number(bytes.readBigUInt64LE(base + 24)),
        size: Number(bytes.readBigUInt64LE(base + 32)),
        link: bytes.readUInt32LE(base + 40),
        entsize: Number(bytes.readBigUInt64LE(base + 56)),
      });
    }
    for (const sec of sections) {
      if (sec.type !== 11) continue; // SHT_DYNSYM
      const strtab = sections[sec.link];
      if (!strtab || strtab.type !== 3 || !Number.isSafeInteger(strtab.offset) || !Number.isSafeInteger(strtab.size)
        || strtab.offset + strtab.size > bytes.length) continue;
      const entsize = sec.entsize >= 24 ? sec.entsize : 24;
      if (!Number.isSafeInteger(sec.offset) || !Number.isSafeInteger(sec.size) || sec.offset + sec.size > bytes.length) continue;
      const count = Math.min(Math.floor(sec.size / entsize), 500000);
      for (let i = 0; i < count; i++) {
        const sym = sec.offset + i * entsize;
        const stName = bytes.readUInt32LE(sym);
        const stInfo = bytes.readUInt8(sym + 4);
        const stShndx = bytes.readUInt16LE(sym + 6);
        const bind = stInfo >> 4;
        if (stName === 0 || stShndx === 0 || (bind !== 1 && bind !== 2) || stName >= strtab.size) continue;
        const start = strtab.offset + stName;
        const end = bytes.indexOf(0, start);
        const limit = end >= 0 ? Math.min(end, start + 256, strtab.offset + strtab.size) : Math.min(start + 256, strtab.offset + strtab.size);
        exports.add(bytes.subarray(start, limit).toString('utf8'));
      }
    }
  }
  return { valid: true, x64: arch === 'x64', arch, exports };
}

function insideRoot(prefix, target, message) {
  const resolved = realpathSync(target);
  const ok = process.platform === 'win32'
    ? resolved.toLowerCase().startsWith(prefix.toLowerCase())
    : resolved.startsWith(prefix);
  if (!ok) throw new Error(message);
  return resolved;
}

export function inspectQQ(root) {
  if (typeof root !== 'string' || !root.trim() || /^(?:\\\\|\/\/)/.test(root.trim())) {
    throw new Error('QQ 安装目录无效');
  }
  root = realpathSync(resolve(root));
  const prefix = root.endsWith(sep) ? root : root + sep;
  const hasWindowsLayout = existsSync(join(root, 'versions', 'config.json')) || existsSync(join(root, 'QQ.exe'));
  const hasLinuxLayout = existsSync(join(root, 'qq')) && existsSync(join(root, 'resources', 'app', 'package.json'));

  if (!hasWindowsLayout && hasLinuxLayout) {
    const executable = insideRoot(prefix, join(root, 'qq'), 'QQ 主程序超出安装目录');
    const appDir = insideRoot(prefix, join(root, 'resources', 'app'), 'QQ 应用目录超出安装目录');
    const metadata = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
    if (typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-_+.\w]*)?$/.test(metadata.version)) {
      throw new Error('QQ 当前版本字段无效');
    }
    const wrapper = insideRoot(prefix, join(appDir, 'wrapper.node'), 'QQ 原生模块超出安装目录');
    if (!statSync(executable).isFile() || !statSync(wrapper).isFile()) throw new Error('QQ 安装不完整');
    const runtimeBytes = readFileSync(executable);
    const wrapperBytes = readFileSync(wrapper);
    const runtimeELF = readELF64Info(runtimeBytes);
    const wrapperELF = readELF64Info(wrapperBytes);
    const arch = metadata.eleArch || runtimeELF.arch || null;
    if (metadata.eleArch && !['x64', 'arm64'].includes(metadata.eleArch)) {
      throw new Error('QQ 客户端架构不受支持');
    }
    if (metadata.eleArch && runtimeELF.arch && metadata.eleArch !== runtimeELF.arch) {
      throw new Error('QQ 架构配置不一致');
    }
    let fuses = null;
    try { fuses = readFuses(runtimeBytes); } catch { /* Optional in non-standard builds. */ }
    const missingExports = runtimeELF.valid && runtimeELF.arch
      ? requiredNapiExports.filter(name => !runtimeELF.exports.has(name))
      : requiredNapiExports;
    const targetMatch = verifiedVersions.includes(metadata.version);
    const supported = Boolean(runtimeELF.valid && runtimeELF.arch && wrapperELF.valid && wrapperELF.arch === runtimeELF.arch
      && (!metadata.eleArch || metadata.eleArch === runtimeELF.arch) && missingExports.length === 0);
    return {
      platform: 'linux', root, executable, wrapper, version: metadata.version, arch,
      bytecode: metadata.isByteCodeShell === true, fuses, targetMatch, supported, missingExports,
      runtimeVerified: false,
      bootstrap: 'cpp-native',
      inspectorDisabledBuildDiagnostic: runtimeBytes.includes(Buffer.from('Inspector is not available when Node is compiled --without-v8-platform and --without-inspector.\0')),
      runtimeSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
      wrapperSha256: createHash('sha256').update(wrapperBytes).digest('hex'),
    };
  }

  const config = JSON.parse(readFileSync(join(root, 'versions/config.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+-\d+$/.test(config.curVersion)) throw new Error('QQ 当前版本字段无效');
  const versionDir = insideRoot(prefix, join(root, 'versions', config.curVersion), 'QQ 版本目录超出安装目录');
  const appDir = join(versionDir, 'resources/app');
  const metadata = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  if (metadata.version !== config.curVersion || metadata.eleArch !== 'x64') {
    throw new Error('QQ 版本配置不一致，或客户端不是 x64');
  }
  const executable = join(root, 'QQ.exe');
  const wrapper = join(appDir, 'wrapper.node');
  if (!statSync(executable).isFile() || !statSync(wrapper).isFile()) throw new Error('QQ 安装不完整');
  const runtimeBytes = readFileSync(join(versionDir, 'QQNT.dll'));
  const wrapperBytes = readFileSync(wrapper);
  const runtimePE = readPE64Info(runtimeBytes);
  const wrapperPE = readPE64Info(wrapperBytes);
  let fuses = null;
  try { fuses = readFuses(runtimeBytes); } catch { /* Optional in non-standard builds. */ }
  const missingExports = runtimePE.x64 ? requiredNapiExports.filter(name => !runtimePE.exports.has(name)) : requiredNapiExports;
  const targetMatch = verifiedVersions.includes(metadata.version);
  const supported = metadata.eleArch === 'x64' && runtimePE.x64 && wrapperPE.x64 && missingExports.length === 0;
  return {
    platform: 'win32', root, executable, wrapper, version: metadata.version, arch: metadata.eleArch,
    bytecode: metadata.isByteCodeShell === true, fuses, targetMatch, supported, missingExports,
    runtimeVerified: false,
    bootstrap: 'cpp-native',
    inspectorDisabledBuildDiagnostic: runtimeBytes.includes(Buffer.from('Inspector is not available when Node is compiled --without-v8-platform and --without-inspector.\0')),
    runtimeSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
    wrapperSha256: createHash('sha256').update(wrapperBytes).digest('hex'),
  };
}

// Linux QQ stores downloaded hot-updates under $XDG_CONFIG_HOME/QQ/versions/<curVersion>.
export function resolveLinuxWrapper(qq, configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')) {
  if (!qq || qq.platform !== 'linux') return qq?.wrapper;
  try {
    const versionsRoot = realpathSync(join(configHome, 'QQ', 'versions'));
    const prefix = versionsRoot.endsWith(sep) ? versionsRoot : versionsRoot + sep;
    const cfg = JSON.parse(readFileSync(join(versionsRoot, 'config.json'), 'utf8'));
    if (typeof cfg?.curVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-_+.\w]*)?$/.test(cfg.curVersion)) return qq.wrapper;
    const verDir = realpathSync(join(versionsRoot, cfg.curVersion));
    if (!verDir.startsWith(prefix)) return qq.wrapper;
    for (const candidate of [join(verDir, 'resources', 'app', 'wrapper.node'), join(verDir, 'wrapper.node')]) {
      if (!existsSync(candidate)) continue;
      const resolved = realpathSync(candidate);
      if (!resolved.startsWith(prefix) || !statSync(resolved).isFile()) continue;
      const info = readELF64Info(readFileSync(resolved));
      if (info.valid && info.arch === qq.arch) return resolved;
    }
  } catch { /* Fall back to base installation wrapper.node. */ }
  return qq.wrapper;
}

export function bootstrapInput({ executable, wrapper, dll, payload, pipe, token }) {
  for (const value of [executable, wrapper, dll, payload, pipe, token]) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('原生引导配置无效');
  }
  const source = `(() => { const load = typeof require === 'function' ? require : process.getBuiltinModule?.('module')?.createRequire(process.execPath) ?? process.mainModule?.require.bind(process.mainModule); if (!load) throw new Error('QQ 没有可用 CommonJS 入口'); try { return load(${JSON.stringify(payload)}).startNative(${JSON.stringify({ pipe, token })}, globalThis.__openqq_exports); } finally { delete globalThis.__openqq_exports; } })()`;
  return [executable, wrapper, dll, source].join('\n') + '\n';
}
