'use strict';

const { createEventReceiver } = require('./events.cjs');
const { createActionHandler } = require('./actions.cjs');
const { configureNativePacket } = require('./packet-native.cjs');

// Only the client-created session is observed; login tickets never leave QQ.
function createSessionHook(report) {
  const restorers = [];
  const observed = new WeakSet();
  const generations = new WeakMap();
  const attached = new Map();
  let active = true;

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
      attachment.actions = createActionHandler(session, self, current, {
        expandForward: receive.expandForward, fetchMessage: receive.fetchMessage, fetchHistory: receive.fetchHistory,
        friendList: receive.friendList, friendsWithCategory: receive.friendsWithCategory, lookupRecent: receive.lookupRecent,
        resolveMedia: receive.resolveMedia, lookupMedia: receive.lookupMedia, record: receive.record, groups: receive.groups,
        waitFor: receive.waitFor, resolveUin: receive.resolveUin, remember: receive.remember,
      });
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
      emit({ type: 'session_ready', self_id: self.uin, services: registrations.map(value => value.source) });
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
    return sessions[0].actions.execute(request);
  }
  return { hookWrapper, dispose, execute };
}

function startNative(config, wrapper) {
  if (globalThis.__openqq_hook) throw new Error('OpenQQ 已挂接');
  configureNativePacket(config.qqVersion);
  const socket = require('node:net').createConnection(config.pipe);
  function write(event) {
    if (socket.writableLength > 1024 * 1024) { connection.dispose(); return; }
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
      socket.destroy();
    },
  };
  socket.on('close', () => connection.dispose());
  socket.on('error', () => connection.dispose());
  socket.setEncoding('utf8');
  let buffer = '';
  let busy = 0;
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { connection.dispose(); return; }
    for (let end; (end = buffer.indexOf('\n')) !== -1;) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let frame;
      try {
        frame = JSON.parse(line);
        if (frame?.type !== 'action' || !/^[a-f0-9]{32}$/.test(frame.id) || busy >= 32) throw new Error('无效动作帧');
      } catch { connection.dispose(); return; }
      busy++;
      hook.execute(frame.request).then(data => {
        if (!disposed) write({ type: 'action_result', id: frame.id, response: { status: 'ok', retcode: 0, data } });
      }, error => {
        if (!disposed) write({ type: 'action_result', id: frame.id, response: { status: 'failed', retcode: error.retcode ?? 1500, data: null, message: error.message } });
      }).finally(() => { busy--; });
    }
  });
  socket.write(JSON.stringify({ type: 'hello', token: config.token, pid: process.pid }) + '\n');
  globalThis.__openqq_hook = connection;
  try { return hook.hookWrapper(wrapper); }
  catch (error) { connection.dispose(); throw error; }
}

module.exports = { createSessionHook, startNative };
