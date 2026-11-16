import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supported = (process.platform === 'win32' && process.arch === 'x64')
  || (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch));
if (!supported) throw new Error('原生引导器仅支持 Windows x64 与 Linux x64/arm64');

const build = join(root, '.runtime', 'native-build');
mkdirSync(build, { recursive: true });
const args = ['-S', join(root, 'native'), '-B', build, '-DCMAKE_BUILD_TYPE=Release'];

// Use an installed compiler; never download a toolchain or runtime.
const hasGxx = spawnSync('g++', ['--version'], { windowsHide: true }).status === 0;
const hasNinja = spawnSync('ninja', ['--version'], { windowsHide: true }).status === 0;
if (hasGxx && hasNinja) {
  args.push('-G', 'Ninja', '-DCMAKE_CXX_COMPILER=g++');
} else if (hasGxx && process.platform === 'linux') {
  args.push('-DCMAKE_CXX_COMPILER=g++');
}

execFileSync('cmake', args, { stdio: 'inherit', windowsHide: true });
execFileSync('cmake', ['--build', build, '--config', 'Release'], { stdio: 'inherit', windowsHide: true });
