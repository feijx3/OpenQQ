'use strict';

const nodePath = require('node:path');
const nodeFs = require('node:fs');
const Module = require('node:module');
const { createEventReceiver } = require('./events.cjs');

// actions.cjs 不被打包进 session.cjs，而是运行时 require：改完 dist/native/actions.cjs 后，
// 下一次动作调用就会自动重载，不需要重启 QQ 或 OpenQQ。
const actionsPath = nodePath.join(__dirname, 'actions.cjs');

// 热重载必须连依赖的兄弟模块一起清缓存，否则 actions.cjs 换新了、它 require 的
// oidb-actions.cjs 还是旧的那份——表现是「表里明明加了动作，却回 尚未支持动作」。
// 这里不写死模块名：清掉同目录下所有已载入的 .cjs，新增模块不用回来改这份清单。
function loadActions() {
  let names;
  try { names = nodeFs.readdirSync(__dirname); } catch { names = ['actions.cjs']; }
  for (const name of names) {
    if (!name.endsWith('.cjs')) continue;
    const full = nodePath.join(__dirname, name);
    if (full === __filename) continue;
    try { delete require.cache[require.resolve(full)]; } catch { /* 未载入或文件不存在，跳过 */ }
  }
  // actions.cjs 本身不能走 require：实测清完 require.cache 再 require，拿到的仍是旧模块，
  // 表现是重载看着成功、新加的 validateAction 分支却照样回「尚未支持动作」。
  // 改读源码 + 用全新 Module 实例求值，不经过 require.cache，所以拿到的确实是磁盘上的最新代码。
  // 但「改了就生效」只对 handler 成立：主进程 src/actions.mjs 持有的是启动时那份 validateAction，
  // 换不到新的。所以动到「注册面」（新增 validateAction 分支、给动作表新增键）仍然需要重启，
  // 完整边界见 docs/hot-attach.md 里那张表。
  const source = nodeFs.readFileSync(actionsPath, 'utf8');
  const fresh = new Module(actionsPath, null);
  fresh.filename = actionsPath;
  fresh.paths = Module._nodeModulePaths(__dirname);
  fresh._compile(source, actionsPath);
  return fresh.exports;
}

// 只在 mtime 变了才重载；重载失败保留旧 handler，并留一条可查的日志（不静默吞掉）。
function reloadActionsIfChanged(attachment) {
  if (!attachment?.actionsContext) return;
  let stamp;
  try { stamp = nodeFs.statSync(actionsPath).mtimeMs; } catch { return; }
  if (attachment.actionsStamp === stamp) return;
  try {
    attachment.actions = loadActions().createActionHandler(...attachment.actionsContext);
    attachment.actionsStamp = stamp;
    console.error(`[hot] reloaded actions.cjs mtime=${stamp}`);
  } catch (error) {
    console.error(`[hot] reload failed: ${(error && error.stack) || error}`);
  }
}

const { createActionHandler } = loadActions();

// Only the client-created session is observed; login tickets never leave QQ.
function createSessionHook(report) {
  const restorers = [];
  const observed = new WeakSet();
  const generations = new WeakMap();
  const attached = new Map();
  let active = true;
  let lastReady = null; // 断线重连后重放用

  function emit(event) {
    if (!active) return;
    try { report(event); } catch { /* The observer must not interrupt QQ callbacks. */ }
  }

  function replace(target, name, wrap) {
    const original = target?.[name];
    if (typeof original !== 'function') return false;
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    const replacement = wrap(original);
    if (descriptor && !('value' in descriptor)) throw new Error(`${name} 是访问器，无法安全替换`);
    Object.defineProperty(target, name, { ...(descriptor ?? { configurable: true, writable: true }), value: replacement });
    restorers.push(() => {
      if (target[name] !== replacement) return;
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else delete target[name];
    });
    return true;
  }

  function attach(session, self) {
    if (!active || attached.has(session)) return;
    try {
      if (!/^[1-9]\d*$/.test(self.uin) || !Number.isSafeInteger(Number(self.uin))) throw new Error('会话尚未提供有效 QQ 号');
      const registrations = [];
      const attachment = { registrations, ready: false };
      attached.set(session, attachment);
      const current = () => active && attached.get(session) === attachment;
      const receive = createEventReceiver(session, self, emit, current);
      attachment.actionsContext = [session, self, current, {
        expandForward: receive.expandForward, fetchMessage: receive.fetchMessage, friendList: receive.friendList, lookupRecent: receive.lookupRecent, resolveMedia: receive.resolveMedia, record: receive.record, groups: receive.groups,
      }];
      attachment.actions = createActionHandler(...attachment.actionsContext);
      try { attachment.actionsStamp = nodeFs.statSync(actionsPath).mtimeMs; } catch { attachment.actionsStamp = 0; }
      for (const [source, getter, add, remove] of [
        ['msg', 'getMsgService', 'addKernelMsgListener', 'removeKernelMsgListener'],
        ['buddy', 'getBuddyService', 'addKernelBuddyListener', 'removeKernelBuddyListener'],
        ['group', 'getGroupService', 'addKernelGroupListener', 'removeKernelGroupListener'],
      ]) {
        try {
          if (source !== 'msg' && typeof session[getter] !== 'function') continue;
          const service = session[getter]();
          const listener = new Proxy(Object.create(null), {
            get(_target, name) {
              if (typeof name !== 'string' || !name.startsWith('on')) return undefined;
              return (...args) => {
                if (!current()) return;
                if (source === 'msg') {
                  try { attachment.actions.observe(name, args); }
                  catch (error) { emit({ type: 'event_error', stage: 'send_callback', error: error.message }); }
                  if (name === 'onKickedOffLine') attachment.actions.dispose();
                }
                receive(source, name, args).catch(error => {
                  if (current()) emit({ type: 'event_error', stage: `${source}/${name}`, error: error.message });
                });
              };
            },
          });
          const id = service[add](listener);
          registrations.push({ source, service, id, remove, listener });
        } catch (error) {
          if (source === 'msg') throw error;
          emit({ type: 'event_error', stage: `${source}/listener`, error: error.message });
        }
      }
      attachment.ready = true;
      lastReady = { self_id: self.uin, services: registrations.map(value => value.source) };
      emit({ type: 'session_ready', ...lastReady });
    } catch (error) {
      emit({ type: 'hook_error', stage: 'message_listener', error: error.message });
    }
  }

  function observe(session) {
    if (!active || !session || !['object', 'function'].includes(typeof session) || observed.has(session)) return session;
    observed.add(session);
    try {
      const hooked = replace(session, 'init', original => function (...args) {
        const generation = (generations.get(session) ?? 0) + 1;
        generations.set(session, generation);
        const previous = attached.get(session);
        if (previous) {
          previous.actions.dispose();
          for (const { service, id, remove } of previous.registrations) {
            try { service[remove](id); }
            catch (error) { emit({ type: 'hook_error', stage: 'remove_listener', error: error.message }); }
          }
          attached.delete(session);
        }
        // Deliberately read only identifiers, never serialize the init config.
        const self = { uin: String(args[0]?.selfUin ?? ''), uid: String(args[0]?.selfUid ?? '') };
        const originalListener = args[3];
        args[3] = new Proxy(Object.create(null), {
          get(_target, key) {
            const callback = originalListener?.[key];
            if (key === 'onSessionInitComplete') return function (...values) {
              try { return typeof callback === 'function' ? Reflect.apply(callback, originalListener, values) : undefined; }
              finally {
                if (values[0]?.result !== undefined && values[0].result !== 0) {
                  emit({ type: 'hook_error', stage: 'session_init_result', error: 'QQ 原生会话初始化失败' });
                } else queueMicrotask(() => {
                  if (generations.get(session) === generation) attach(session, self);
                });
              }
            };
            return typeof callback === 'function' ? callback.bind(originalListener) : callback;
          },
        });
        return Reflect.apply(original, this, args);
      });
      if (!hooked) throw new Error('会话没有可挂接的 init 方法');
      emit({ type: 'session_captured' });
    } catch (error) {
      emit({ type: 'hook_error', stage: 'session_init', error: error.message });
    }
    return session;
  }

  function hookWrapper(wrapper) {
    // Only sessions made by the factory are seen. A QQ build that constructs them directly would need a constructor hook.
    const originalFactory = wrapper?.NodeIQQNTWrapperSession;
    if (!originalFactory || !['object', 'function'].includes(typeof originalFactory)) {
      emit({ type: 'hook_error', stage: 'factory', error: '未找到会话工厂导出' });
      return wrapper;
    }
    // Native exports may be non-configurable; shadow methods on a separate factory.
    const factory = typeof originalFactory === 'function' ? originalFactory.bind(originalFactory) : Object.create(originalFactory);
    if (typeof originalFactory === 'function') Object.setPrototypeOf(factory, originalFactory);
    let count = 0;
    for (const name of ['getNTWrapperSession', 'create', 'get']) {
      const original = originalFactory[name];
      if (typeof original !== 'function') continue;
      Object.defineProperty(factory, name, { configurable: true, value: function (...args) {
        return observe(Reflect.apply(original, originalFactory, args));
      } });
      count++;
    }
    if (!count) {
      emit({ type: 'hook_error', stage: 'factory', error: '未找到可挂接的会话工厂' });
      return wrapper;
    }
    const descriptors = Object.getOwnPropertyDescriptors(wrapper);
    const originalDescriptor = descriptors.NodeIQQNTWrapperSession;
    descriptors.NodeIQQNTWrapperSession = {
      value: factory, enumerable: originalDescriptor?.enumerable ?? true,
      configurable: originalDescriptor?.configurable ?? true, writable: originalDescriptor?.writable ?? false,
    };
    const result = Object.create(Object.getPrototypeOf(wrapper), descriptors);
    emit({ type: 'wrapper_loaded', factories: count });
    return result;
  }

  function dispose() {
    active = false;
    for (const { registrations, actions } of attached.values()) {
      actions.dispose();
      for (const { service, id, remove } of registrations) {
        try { service[remove](id); } catch { /* QQ may already have closed the session. */ }
      }
    }
    attached.clear();
    for (const restore of restorers.reverse()) {
      try { restore(); } catch { /* Never throw into a closing QQ session. */ }
    }
    restorers.length = 0;
  }
  async function execute(request) {
    const sessions = [...attached.values()].filter(value => value.ready);
    if (!active || sessions.length !== 1) throw Object.assign(new Error('需要唯一的已初始化 QQ 会话'), { retcode: 1502 });
    reloadActionsIfChanged(sessions[0]);
    return sessions[0].actions.execute(request);
  }
  // 断线重连后重放会话状态：session_ready 只在 QQ 会话初始化时产生一次，
  // 不重放的话 OpenQQ 侧拿不到 self_id，前置层会判 ready=false、动作全回 1502。
  function resume() {
    if (!lastReady) return false;
    emit({ type: 'session_ready', ...lastReady, resumed: true });
    return true;
  }

  return { hookWrapper, dispose, execute, resume };
}

function startNative(config, wrapper) {
  if (globalThis.__openqq_hook) throw new Error('OpenQQ 已挂接');
  let socket = null; // 可重连：断线后换新 socket，不再 dispose
  // 丢弃计数：OpenQQ 重启期间事件没有去处，这是设计上的降级，但必须可查 ——
  // 静默 return 会让「这次重启到底丢了多少条消息」永远无从判断。
  let droppedEvents = 0;
  let lastDropLog = 0;
  function dropEvent(reason) {
    droppedEvents++;
    const now = Date.now();
    if (now - lastDropLog < 60000) return;
    lastDropLog = now;
    console.error(`[ipc] event dropped (${reason}); dropped so far=${droppedEvents}`);
  }
  function write(event) {
    if (!socket || socket.destroyed) { dropEvent('no connection'); return; }
    if (socket.writableLength > 1024 * 1024) { dropEvent('backlog over 1 MiB'); return; }
    let frame;
    try {
      frame = JSON.stringify(event, (_key, value) => value instanceof Map ? Object.fromEntries(value)
        : typeof value === 'bigint' ? String(value) : value) + '\n';
      if (Buffer.byteLength(frame) > 1024 * 1024) throw new Error('事件超过 1 MiB');
    } catch {
      frame = JSON.stringify({ type: 'event_error', stage: 'serialize', error: '事件无法序列化或超过 1 MiB，已跳过' }) + '\n';
    }
    socket.write(frame);
  }
  const hook = createSessionHook(write);
  let disposed = false;
  const connection = {
    dispose() {
      if (disposed) return;
      disposed = true;
      hook.dispose();
      delete globalThis.__openqq_hook;
      if (socket) { try { socket.destroy(); } catch {} }
    },
    // 供诊断读取：被丢弃的事件总数。
    droppedEvents() { return droppedEvents; },
  };
  let gen = 0;
  let retryTimer = null;
  // 重连间隔：要明显短于服务端等 QQ 连回来的窗口（默认 6 秒），又不至于空转。
  const reconnectMs = 300;

  function scheduleReconnect() {
    if (disposed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (disposed) return;
      try { connect(); } catch { scheduleReconnect(); }
    }, reconnectMs);
    if (retryTimer.unref) retryTimer.unref();
  }

  function connect() {
    if (disposed) return;
    const s = require('node:net').createConnection(config.pipe);
    const my = ++gen;
    // 在途动作计数绑在这一代连接上：断线后旧连接上还没结束的动作减的是自己的计数，
    // 不会把新连接的计数减成负数（那会让 busy >= 32 的并发上限失效）。
    let inflight = 0;
    socket = s;
    s.on('close', () => { if (my === gen) scheduleReconnect(); });
    s.on('error', () => { try { s.destroy(); } catch { /* 交给 close 去重连 */ } });
    s.setEncoding('utf8');
    let buffer = '';
    s.on('data', chunk => {
      if (my !== gen) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { try { s.destroy(); } catch { /* 帧过大，断开等重连 */ } return; }
      for (let end; (end = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let frame;
        try {
          frame = JSON.parse(line);
          if (frame?.type !== 'action' || !/^[a-f0-9]{32}$/.test(frame.id) || inflight >= 32) throw new Error('无效动作帧');
        } catch { try { s.destroy(); } catch { /* 收到坏帧，断开等重连 */ } return; }
        inflight++;
        hook.execute(frame.request).then(data => {
          // hook 有两种返回形态：上游 handler 给裸数据，我们新增的 handler 直接给 OneBot 回执。
          // 后者必须原样透传——无条件包一层 { status:'ok', retcode:0 } 会把失败吞掉，
          // 调用方永远看到 retcode 0（set_group_search 超时、危险动作 dryrun 都会被报成功）。
          const replay = data && typeof data === 'object'
            && (data.status === 'ok' || data.status === 'failed')
            && Number.isSafeInteger(data.retcode);
          if (!disposed) write({ type: 'action_result', id: frame.id, response: replay ? data : { status: 'ok', retcode: 0, data } });
        }, error => {
          if (!disposed) write({ type: 'action_result', id: frame.id, response: { status: 'failed', retcode: error.retcode ?? 1500, data: null, message: error.message } });
        }).finally(() => { inflight--; });
      }
    });
    s.write(JSON.stringify({ type: 'hello', token: config.token, pid: process.pid }) + '\n');
    // 必须是同一个 socket 上顺序写：服务端先读完 hello 完成认证，才会把这个帧当事件处理。
    // 首次注入时 QQ 会话还没初始化，resume() 返回 false，等它自己上报 session_ready。
    try { hook.resume(); } catch { /* 会话尚未就绪 */ }
  }

  connect();
  globalThis.__openqq_hook = connection;
  try { return hook.hookWrapper(wrapper); }
  catch (error) { connection.dispose(); throw error; }
}

module.exports = { createSessionHook, startNative };
