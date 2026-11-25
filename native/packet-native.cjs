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
      if (platform !== 'win32' || arch !== 'x64') {
        throw new Error('当前群文件原生通道仅适配 Windows x64');
      }
      const native = load();
      if (typeof native?.initialize !== 'function' || typeof native?.send !== 'function') {
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
let active;
let configuredVersion;

function configureNativePacket(version) {
  configuredVersion = version;
}

function ensureNativePacket(version) {
  active = initialize(version);
  return active;
}

function getPacketSender() {
  if (!active && configuredVersion === undefined) return undefined;
  return (service, command, data) => {
    const state = active ?? ensureNativePacket(configuredVersion);
    return state.native.send(service, command, data);
  };
}

module.exports = { configureNativePacket, createPacketBootstrap, getPacketSender };
