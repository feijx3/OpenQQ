'use strict';

const { fail } = require('./common.cjs');

// The C++ profile table owns the verified QQ builds. initialize() rejects an
// unknown build before installing any hook, so JS keeps no second version list.
// The injectable loader lets tests exercise this policy without loading QQ.
function createPacketBootstrap(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const load = options.load ?? (() => {
    const bridge = globalThis.__openqq_packet;
    if (!bridge) {
      throw new Error('OpenQQ 原生引导器缺少 packet bridge；请运行 npm run build:native 后重启 QQ');
    }
    return bridge;
  });

  let state = null;
  let initializationError = null;
  let initializedVersion;
  return function ensurePacket(version) {
    if (initializedVersion && version !== initializedVersion) {
      throw fail('原生发包通道版本不能在进程内切换', 1500);
    }
    if (state) return state;
    // A failed native installation is not retried in the same QQ process.
    if (initializationError) throw initializationError;

    try {
      if (typeof version !== 'string' || !version.trim()) {
        throw new Error('缺少 QQ 版本号，未安装原生通道；请重新构建并重启 QQ');
      }
      if (platform !== 'win32') {
        const environment = platform === 'linux' ? 'Linux（含 Docker Linux 容器）' : platform;
        throw new Error(environment + ' 尚未适配群文件原生通道；当前仅支持 Windows x64，未安装 Hook');
      }
      if (arch !== 'x64') {
        throw new Error('Windows ' + arch + ' 尚未适配群文件原生通道；当前仅支持 Windows x64');
      }
      const native = load();
      if (typeof native?.initialize !== 'function' || typeof native?.send !== 'function'
        || typeof native?.release !== 'function') {
        throw new Error('OpenQQ packet bridge 导出不完整');
      }
      initializedVersion = version;
      if (native.initialize(version) !== true) {
        throw new Error('OpenQQ packet bridge 未报告初始化成功');
      }
      state = { version, native };
      console.info('[OpenQQ/packet] 独立原生通道已初始化，QQ ' + version);
      return state;
    } catch (cause) {
      initializationError = fail('群文件原生通道初始化失败: ' + cause.message, 1500);
      throw initializationError;
    }
  };
}

// Configuration happens when the QQ payload starts, but installation waits for
// an actual packet request. Cached media URLs and unrelated actions need no hook.
// Keep successful hooks alive until QQ exits, including across session rebuilds.
const initialize = createPacketBootstrap();
let configuredVersion;

function configureNativePacket(version) {
  if (typeof version !== 'string' || !version.trim()) {
    throw fail('缺少 QQ 版本号，未安装原生通道；请重新构建并重启 QQ', 1500);
  }
  configuredVersion = version;
}

// Native send returns a promise plus an opaque tracking ID. Releasing this
// handle only erases OpenQQ bookkeeping; QQ still owns its deferred/promise.
function createPacketSender(ensurePacket) {
  return (service, command, data) => {
    const state = ensurePacket();
    const handle = state.native.send(service, command, data);
    if (!handle || typeof handle.id !== 'string' || !/^[1-9]\d*$/.test(handle.id)
      || typeof handle.promise?.then !== 'function') {
      if (typeof handle?.id === 'string' && /^[1-9]\d*$/.test(handle.id)) {
        state.native.release(handle.id);
      }
      throw fail('OpenQQ 原生通道返回无效的请求句柄；请重新构建并重启 QQ', 1500);
    }
    let released = false;
    return {
      promise: handle.promise,
      release() {
        if (released) return;
        released = true;
        state.native.release(handle.id);
      },
    };
  };
}

function getPacketSender() {
  // Never interpret missing configuration as a test-mode bypass.
  return createPacketSender(() => initialize(configuredVersion));
}

module.exports = { configureNativePacket, createPacketBootstrap, createPacketSender, getPacketSender };
