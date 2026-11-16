import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUI } from '../ui/build.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const win = process.platform === 'win32';
const platformTag = win ? `win-${process.arch}` : `${process.platform}-${process.arch}`;
const releaseName = `${pkg.name}-v${pkg.version}-${platformTag}`;
const distRoot = join(root, 'dist');
const releaseDir = join(distRoot, releaseName);
const archivePath = join(distRoot, win ? `${releaseName}.zip` : `${releaseName}.tar.gz`);

function writeOut(relPath, content) {
  const fullPath = join(releaseDir, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  return fullPath;
}

function copyOut(srcRel, destRel = srcRel) {
  const fullPath = join(releaseDir, destRel);
  mkdirSync(dirname(fullPath), { recursive: true });
  copyFileSync(join(root, srcRel), fullPath);
  return fullPath;
}

function createReleaseMetadata() {
  const runtimePkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    private: true,
    type: 'module',
    engines: pkg.engines,
    scripts: {
      init: 'node src/main.mjs init',
      doctor: 'node src/main.mjs doctor',
      start: 'node src/main.mjs start',
      webui: 'node src/main.mjs webui',
    },
  };
  writeOut('package.json', JSON.stringify(runtimePkg, null, 2) + '\n');

  copyOut('config/openqq.example.json');
  copyOut(win ? 'native/bin/openqq-launch.exe' : 'native/bin/openqq-launch');
  copyOut(win ? 'native/bin/openqq-bootstrap.dll' : 'native/bin/openqq-bootstrap.so');
  if (!win) {
    chmodSync(join(releaseDir, 'native/bin/openqq-launch'), 0o755);
    chmodSync(join(releaseDir, 'native/bin/openqq-bootstrap.so'), 0o755);
  }
  copyOut('LICENSE');
  // Optional voice encoder (MIT): shipped when installed, so WAV can be sent as a voice message without extra setup.
  const silkDir = join(root, 'node_modules', 'silk-wasm');
  if (existsSync(silkDir)) cpSync(silkDir, join(releaseDir, 'node_modules', 'silk-wasm'), { recursive: true });

  if (win) {
    writeOut('openqq.cmd', [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'if "%~1"=="" (',
      '  node "%~dp0src\\main.mjs" start',
      ') else (',
      '  node "%~dp0src\\main.mjs" %*',
      ')',
      'if errorlevel 1 if "%~1"=="" pause',
      '',
    ].join('\r\n'));

    writeOut('README.txt', [
      `OpenQQ v${pkg.version} (Windows x64 Release)`,
      '========================================',
      '',
      '环境要求:',
      '1. Windows 10 / 11 x64 与 Windows x64 QQ NT 9.x',
      '2. Node.js >= 22 (https://nodejs.org/)',
      '3. 原生引导器已包含，使用 Windows 系统运行库',
      '',
      '快速启动:',
      '- 双击 openqq.cmd 或在终端执行: openqq.cmd',
      '- 环境检测: openqq.cmd doctor',
      '- 仅打开 Web 配置向导: openqq.cmd webui',
      '- 命令行初始化配置: openqq.cmd init',
      '',
      '首次启动会自动打开本机 WebUI 配置向导；请先完全退出正在运行的 QQ，再由 OpenQQ 拉起 QQ 登录。',
      '',
    ].join('\r\n'));
  } else {
    const sh = writeOut('openqq.sh', [
      '#!/usr/bin/env sh',
      'set -eu',
      'DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'cd "$DIR"',
      'if [ "$#" -eq 0 ]; then',
      '  exec node "$DIR/src/main.mjs" start',
      'else',
      '  exec node "$DIR/src/main.mjs" "$@"',
      'fi',
      '',
    ].join('\n'));
    chmodSync(sh, 0o755);

    writeOut('README.txt', [
      `OpenQQ v${pkg.version} (Linux ${process.arch} Release)`,
      '========================================',
      '',
      '环境要求:',
      '1. Linux (x64 / arm64) 与官方 Linux QQ NT（通常位于 /opt/QQ）',
      '2. Node.js >= 22 (https://nodejs.org/)',
      '3. 原生引导器已包含（openqq-launch 与 openqq-bootstrap.so）',
      '',
      '快速启动:',
      '- 启动桥接: ./openqq.sh',
      '- 环境检测: ./openqq.sh doctor',
      '- 仅打开 Web 配置向导: ./openqq.sh webui',
      '- 命令行初始化配置: ./openqq.sh init',
      '',
      '首次启动会自动打开本机 WebUI 配置向导；请先完全退出正在运行的 QQ，再由 OpenQQ 拉起 QQ 登录。',
      '',
    ].join('\n'));
  }
}

function packArchive() {
  if (win) {
    const tarExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tarExe, ['-a', '-c', '-f', archivePath, '-C', distRoot, releaseName], { stdio: 'inherit' });
    return;
  }
  execFileSync('tar', ['-czf', archivePath, '-C', distRoot, releaseName], { stdio: 'inherit' });
}

async function main() {
  const started = Date.now();
  execFileSync(process.execPath, [join(root, 'scripts/build-native.mjs')], { stdio: 'inherit' });
  rmSync(releaseDir, { recursive: true, force: true });
  rmSync(archivePath, { force: true });
  mkdirSync(releaseDir, { recursive: true });

  // 1. Main Node.js entrypoint (ESM bundle including ws + native/actions.cjs).
  const mainBundle = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.mjs'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    minify: true,
    legalComments: 'none',
    banner: { js: 'import { createRequire as __openqqCreateRequire } from "node:module"; const require = __openqqCreateRequire(import.meta.url);' },
  });
  const mainOut = mainBundle.outputFiles[0].text;
  writeOut('src/main.mjs', mainOut);

  // 2. Native QQ session payload (CJS bundle loaded inside QQNT's Node runtime).
  const sessionBundle = await build({
    absWorkingDir: root,
    entryPoints: ['native/session.cjs'],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: ['node20'],
    minify: true,
    legalComments: 'none',
    external: ['node:*'],
  });
  const sessionOut = sessionBundle.outputFiles[0].text;
  writeOut('native/session.cjs', sessionOut);

  // 3. WebUI assets.
  await buildUI({ outdir: join(releaseDir, 'web'), logLevel: 'warning' });
  copyOut('web/index.html', 'web/index.html');
  copyOut('web/setup.html', 'web/setup.html');
  copyOut('web/logo.svg', 'web/logo.svg');

  // 4. Runtime package metadata, launchers and archive.
  createReleaseMetadata();
  packArchive();

  const kb = bytes => (bytes / 1024).toFixed(1) + ' KB';
  console.log(`Release built in ${Date.now() - started}ms:`);
  console.log(`  Dir:     ${releaseDir}`);
  console.log(`  Archive: ${archivePath} (${kb(statSync(archivePath).size)})`);
  console.log(`  src/main.mjs:       ${kb(Buffer.byteLength(mainOut))}`);
  console.log(`  native/session.cjs: ${kb(Buffer.byteLength(sessionOut))}`);
  console.log(`  web/app.js:         ${kb(statSync(join(releaseDir, 'web/app.js')).size)}`);
}

await main();
