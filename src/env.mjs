import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectQQ } from './qq.mjs';

export function isUncPath(value) {
  return typeof value === 'string' && /^(?:\\\\|\/\/)/.test(value.trim());
}

function existingDir(dir) {
  try { return Boolean(dir) && !isUncPath(dir) && statSync(dir).isDirectory(); } catch { return false; }
}

function existingFile(file) {
  try { return Boolean(file) && !isUncPath(file) && statSync(file).isFile(); } catch { return false; }
}

function uniquePaths(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (!item || typeof item !== 'string') continue;
    const normalized = resolve(item);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function queryWindowsRegistryQQPaths() {
  if (process.platform !== 'win32') return [];
  const regExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT',
    'HKLM\\SOFTWARE\\Tencent\\QQNT',
    'HKCU\\SOFTWARE\\Tencent\\QQNT',
  ];
  const dirs = [];
  for (const key of keys) {
    try {
      const output = execFileSync(regExe, ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/^\s*(Install|InstallLocation|DisplayIcon|UninstallString)\s+REG_\w+\s+(.+)$/i);
        if (!match) continue;
        let raw = match[2].trim();
        if (raw.startsWith('"')) raw = raw.slice(1, raw.indexOf('"', 1) > 0 ? raw.indexOf('"', 1) : undefined);
        raw = raw.replace(/,\d+$/, '').trim();
        if (!raw) continue;
        if (/\.(exe|ico)$/i.test(raw)) raw = dirname(raw);
        dirs.push(raw);
      }
    } catch { /* Missing key is normal. */ }
  }
  return dirs;
}

function detectLinuxPaths() {
  const candidates = ['/opt/QQ', '/usr/lib/qq', '/usr/share/qq', '/usr/local/opt/QQ'];
  try {
    const home = homedir();
    if (home) candidates.push(join(home, '.local', 'share', 'QQ'), join(home, 'Applications', 'QQ'));
  } catch { /* ignore */ }
  for (const bin of ['/usr/bin/qq', '/usr/local/bin/qq']) {
    try {
      if (existsSync(bin)) candidates.push(dirname(realpathSync(bin)));
    } catch { /* ignore */ }
  }
  return candidates;
}

export function detectQQInstallations() {
  const candidates = [];
  if (process.env.OPENQQ_QQ_ROOT) candidates.push(process.env.OPENQQ_QQ_ROOT);
  if (process.platform === 'win32') {
    candidates.push(...queryWindowsRegistryQQPaths());
    const roots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LocalAppData,
      'C:',
      'D:',
      'E:',
    ].filter(Boolean);
    for (const base of roots) {
      candidates.push(join(base, 'Tencent', 'QQNT'));
      candidates.push(join(base, 'Tencent', 'QQ'));
      candidates.push(join(base, 'QQNT'));
      candidates.push(join(base, 'QQ'));
    }
  } else if (process.platform === 'linux') {
    candidates.push(...detectLinuxPaths());
  }
  const found = [];
  for (const dir of uniquePaths(candidates)) {
    if (!existingDir(dir)) continue;
    const looksValid = process.platform === 'win32'
      ? existingFile(join(dir, 'QQ.exe')) && existingFile(join(dir, 'versions', 'config.json'))
      : existingFile(join(dir, 'qq')) && existingFile(join(dir, 'resources', 'app', 'package.json'));
    if (!looksValid) continue;
    try {
      const info = inspectQQ(dir);
      found.push({ path: info.root, version: info.version, targetMatch: info.targetMatch, supported: info.supported, arch: info.arch });
    } catch (error) {
      found.push({ path: dir, version: null, targetMatch: false, supported: false, error: error.message });
    }
  }
  return found;
}

export function isQQProcessRunning(procRoot = '/proc') {
  if (process.platform === 'win32') {
    const tasklist = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
    try {
      const out = execFileSync(tasklist, ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.split(/\r?\n/).some(line => /^"QQ\.exe",/i.test(line.trim()));
    } catch {
      return false;
    }
  }
  if (process.platform !== 'linux') return false;
  try {
    for (const entry of readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue;
      if (Number(entry) === process.pid) continue;
      const pidDir = join(procRoot, entry);
      try {
        const exe = readlinkSync(join(pidDir, 'exe'));
        if (basename(exe.replace(/ \(deleted\)$/, '')) === 'qq') return true;
      } catch {
        try {
          const comm = readFileSync(join(pidDir, 'comm'), 'utf8').trim();
          if (comm !== 'qq') continue;
          const cmd = readFileSync(join(pidDir, 'cmdline'), 'utf8').split('\0')[0] || '';
          if (basename(cmd) === 'qq') return true;
        } catch { /* process exited or inaccessible */ }
      }
    }
  } catch { /* ignore */ }
  return false;
}

export function detectEnvironment({ projectDir, qqRoot } = {}) {
  const qqInstalls = detectQQInstallations();
  let qqCheck;
  const targetQQ = qqRoot || qqInstalls.find(item => item.supported)?.path || qqInstalls[0]?.path || '';
  if (targetQQ) {
    try {
      const info = inspectQQ(targetQQ);
      const compatible = info.platform === process.platform && info.arch === process.arch && info.supported;
      qqCheck = { path: info.root, valid: compatible, targetMatch: info.targetMatch, version: info.version, arch: info.arch,
        error: compatible ? null : 'QQ 版本、架构或原生导出不兼容' };
    } catch (error) {
      qqCheck = { path: targetQQ, valid: false, targetMatch: false, version: null, arch: null, error: error.message };
    }
  } else {
    qqCheck = { path: '', valid: false, targetMatch: false, version: null, arch: null, error: '未检测到 QQ NT 安装目录' };
  }

  return {
    platform: process.platform,
    arch: process.arch,
    qq: qqCheck,
    qqCandidates: qqInstalls,
    native: probeNative(projectDir),
    qqRunning: isQQProcessRunning(),
    hasSavedHint: existsSync(join(projectDir || '.', 'config', 'openqq.json')),
  };
}

export function probeNative(projectDir = '.') {
  if (process.platform === 'linux') {
    const launcher = join(projectDir, 'native', 'bin', 'openqq-launch');
    const dll = join(projectDir, 'native', 'bin', 'openqq-bootstrap.so');
    const ready = ['x64', 'arm64'].includes(process.arch) && existingFile(launcher) && existingFile(dll);
    return { launcher, dll, ready, error: ready ? null : '缺少 Linux 原生引导器，请先运行 npm run build:native' };
  }
  const launcher = join(projectDir, 'native', 'bin', 'openqq-launch.exe');
  const dll = join(projectDir, 'native', 'bin', 'openqq-bootstrap.dll');
  const ready = process.platform === 'win32' && process.arch === 'x64' && existingFile(launcher) && existingFile(dll);
  return { launcher, dll, ready, error: ready ? null : '缺少 Windows x64 原生引导器，请先运行 npm run build:native' };
}
