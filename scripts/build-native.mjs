import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 构建原生引导器。
//
//   node scripts/build-native.mjs            发布版 → native/bin/openqq-bootstrap.dll
//   node scripts/build-native.mjs --debug    调试版 → native/bin/openqq-bootstrap-debug.dll
//
// 两个产物的差别只有一个：调试版编进原生指针探针（扫内存 + 任意地址读 + 挂全局函数），
// 发布版一行都不编。它们**输出到不同文件名**，所以调试版永远不会覆盖发布版。
//
// 为什么必须分产物而不是"运行时开关"：这三项行为组合会被 Windows Defender 判成
// 通用可疑并直接隔离，与代码是否恶意无关。运行时开关只是"不执行"，二进制里照样
// 留着代码和字符串，照样会被拦。只有编译期排除才真的让那段代码不存在。

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const supported = (process.platform === 'win32' && process.arch === 'x64')
  || (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch));
if (!supported) throw new Error('原生引导器仅支持 Windows x64 与 Linux x64/arm64');

const debugVariant = process.argv.includes('--debug');
const build = join(root, '.runtime', 'native-build');
mkdirSync(build, { recursive: true });

// ⚠️ 两个 option 必须**显式传值**。CMake 会把 option 缓存进 CMakeCache.txt：
// 如果上一次构建传了 -DOPENQQ_DEBUG_VARIANT=ON 而这次不提，缓存里仍是 ON，
// 于是"发布构建"会悄悄产出调试版并覆盖发布位置。显式 OFF 是唯一可靠做法。
const args = [
  '-S', join(root, 'native'),
  '-B', build,
  '-DCMAKE_BUILD_TYPE=Release',
  `-DOPENQQ_DEBUG_VARIANT=${debugVariant ? 'ON' : 'OFF'}`,
  `-DOPENQQ_ENABLE_PROBE=${debugVariant ? 'ON' : 'OFF'}`,
];

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

const suffix = process.platform === 'win32' ? '.dll' : '.so';
const stem = debugVariant ? 'openqq-bootstrap-debug' : 'openqq-bootstrap';
const artifact = join(root, 'native', 'bin', stem + suffix);
if (!existsSync(artifact)) throw new Error(`构建产物不存在：${artifact}`);
const binary = readFileSync(artifact);
const size = statSync(artifact).size;

// ===== 调试版：不发布，只打一行提示 =====
const probeSymbols = ['__openqqNativeProbe', '__openqqNativeScan', 'openqqNativeProbe', 'openqqNativeScan'];
if (debugVariant) {
  const present = probeSymbols.filter((name) => binary.includes(Buffer.from(name, 'latin1')));
  console.log(`\n[debug] ${artifact}  ${size} bytes`);
  console.log(`[debug] 探针符号：${present.length > 0 ? present.join(', ') : '（未检出，编译开关可能没生效）'}`);
  console.log('[debug] 这个产物只用于本地逆向，绝不进 dist / npm / Release。\n');
} else {
  // ===== 发布版：护栏，产物里不得出现原生指针探针 =====
  //
  // 原因（2026-11-20 实测代价）：探针用了 VirtualQuery 扫内存 + 对任意地址做 8 字节读 +
  // napi_create_function 往全局对象挂函数，这三项组合会被 Windows Defender 判定为
  // 通用可疑行为并直接隔离 —— 与代码是否恶意无关。
  const leaked = probeSymbols.filter((name) => binary.includes(Buffer.from(name, 'latin1')));
  if (leaked.length > 0) {
    throw new Error(
      `发布产物含原生指针探针（会被杀软拦截并隔离）：${leaked.join(', ')}\n`
      + '探针只能在调试版里编译：node scripts/build-native.mjs --debug（产物名带 -debug，不覆盖发布版）。',
    );
  }
  // 发布版必须**不依赖**任何外部 SSO 组件。
  //
  // 历史：这里原本会检查「产物里必须有 snowluma / openqq-sso-local 的文件名」，
  // 因为那时靠 LoadLibraryW 加载外部组件。现在发送走自研发送通道
  // （改 wrapper.node 里一条 call 的 rel32 指向我们自己的代劳函数），
  // 判据整体反转：**出现外部组件文件名才是违规**。
  const utf16 = (text) => Buffer.from(text, 'utf16le');
  const foreignLoader = ['snowluma-win32-x64.dll', 'openqq-sso-local.dll']
    .filter((name) => binary.includes(utf16(name)));
  if (foreignLoader.length > 0) {
    throw new Error(
      `发布产物里仍含外部 SSO 组件文件名：${foreignLoader.join(', ')}\n`
      + '发布版不得依赖用户自备的第三方组件：检查 bootstrap.cpp 的 loadSsoBridge() 是否又去 LoadLibrary 了。',
    );
  }
  // 自研通道的交接入口必须在，否则所有 SSO 动作会静默回 1404。
  //
  // 只对 Windows 强制要求：这条补丁改的是 wrapper.node 里某条 call 的 rel32，
  // 偏移来自 Windows 版 wrapper.node 的逆向结论。Linux 的 wrapper.node 是另一个
  // 二进制、偏移不同，那边的引导器（bootstrap_linux.cpp）还没做这一步 ——
  // 因此 Linux 上 SSO 动作会如实回 1404，其余功能不受影响，不能让它把整个构建打挂。
  const ssoWired = binary.includes(Buffer.from('__openqqSsoBodyConv', 'latin1'));
  if (process.platform === 'win32' && !ssoWired) {
    throw new Error(
      '发布产物里没有 __openqqSsoBodyConv —— 自研 SSO 通道没编进去。\n'
      + '检查 bootstrap.cpp 的 installSsoSend() 里是否仍调用 ssoBodyConvInstall() 并注册该入口。',
    );
  }
  console.log(`\n[release] ${artifact}  ${size} bytes（无探针符号${ssoWired ? '，自研 SSO 通道就位' : '；本平台未编入自研 SSO 通道'}）\n`);
}

// 顺带提醒：源码树里留着调试版是正常的，但别让它进发布目录。
const distDebug = join(root, '..', 'OpenQQ-dist');
if (existsSync(distDebug) && debugVariant) {
  console.warn('[warn] 注意：调试版不要复制进 OpenQQ-dist。');
}
