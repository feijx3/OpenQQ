import { once } from 'node:events';
import { createNativeChannel } from '../src/ipc.mjs';
import sessionModule from '../native/session.cjs';

const defaultSelf = { uin: '123456', uid: 'u_self' };

// Connects a mock QQ session to the real IPC channel and native hook for end-to-end action/media tests.
export async function startNativeFixture(t, { channel: existingChannel, init = true, service: serviceOverrides = {}, session: sessionOverrides = {} } = {}) {
  let channel = existingChannel;
  if (!channel) {
    channel = await createNativeChannel();
    t.after(() => channel.close());
  }
  let listener;
  const service = {
    addKernelMsgListener(value) { listener = value; return 1; },
    removeKernelMsgListener() {},
    ...serviceOverrides,
  };
  const session = {
    init(_config, _depends, _dispatcher, callbacks) { callbacks.onSessionInitComplete({ result: 0 }); },
    getMsgService: () => service,
    getMSFService: () => ({ getServerTime: () => '1794470400' }),
    ...sessionOverrides,
  };
  const connected = once(channel.events, 'connected');
  const facade = sessionModule.startNative({ pipe: channel.path, token: channel.token }, { NodeIQQNTWrapperSession: { get: () => session } });
  t.after(() => globalThis.__openqq_hook?.dispose());
  await connected;
  const initialize = async () => {
    const ready = new Promise(resolve => channel.events.on('event', event => { if (event.type === 'session_ready') resolve(); }));
    facade.NodeIQQNTWrapperSession.get().init({ selfUin: defaultSelf.uin, selfUid: defaultSelf.uid }, {}, {}, {});
    await ready;
  };
  if (init) await initialize();
  return {
    channel,
    initialize,
    getListener: () => listener,
  };
}
