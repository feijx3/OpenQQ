import { createServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function allocateChannelPath() {
  if (process.platform === 'win32') {
    return { path: `\\\\.\\pipe\\openqq-${randomBytes(16).toString('hex')}`, ownedDir: null };
  }
  const base = tmpdir();
  const root = Buffer.byteLength(join(base, 'oqq-123456', 'ipc.sock')) <= 96 ? base : '/tmp';
  const dir = mkdtempSync(join(root, 'oqq-'));
  chmodSync(dir, 0o700);
  return { path: join(dir, 'ipc.sock'), ownedDir: dir };
}

export async function createNativeChannel(customPath) {
  const allocated = customPath ? { path: customPath, ownedDir: null } : allocateChannelPath();
  const path = allocated.path;
  const isWindowsPipe = process.platform === 'win32' || path.startsWith('\\\\.\\pipe\\');
  const events = new EventEmitter();
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  let authenticated;
  const pending = new Map();
  function failPending() {
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(Object.assign(new Error('IPC 已断开；已提交的发送结果未确认，请勿自动重试'), { retcode: 1502 }));
    }
    pending.clear();
  }
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy());
    let buffer = '';
    let accepted = false;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      sockets.delete(socket);
      if (accepted) { failPending(); events.emit('disconnected'); }
    });
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
      for (let end; (end = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (!accepted) {
            const candidate = typeof event.token === 'string' ? Buffer.from(event.token) : Buffer.alloc(0);
            if (authenticated || event.type !== 'hello' || candidate.length !== token.length || !timingSafeEqual(candidate, Buffer.from(token)) || !Number.isSafeInteger(event.pid) || event.pid <= 0) {
              socket.destroy(); return;
            }
            accepted = true;
            authenticated = socket;
            socket.setTimeout(0);
            events.emit('connected', { pid: event.pid });
          } else if (event.type === 'action_result') {
            const task = pending.get(event.id);
            if (task) {
              clearTimeout(task.timer);
              pending.delete(event.id);
              task.resolve(event.response);
            }
          } else events.emit('event', event);
        } catch { socket.destroy(); return; }
      }
    });
  });
  server.maxConnections = 8;
  server.on('error', error => events.emit('failure', error));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    if (!isWindowsPipe) chmodSync(path, 0o600);
  } catch (error) {
    if (allocated.ownedDir) rmSync(allocated.ownedDir, { recursive: true, force: true });
    throw error;
  }
  return {
    events, path, token,
    request(request, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        if (!authenticated?.writable || authenticated.destroyed) { reject(Object.assign(new Error('QQ 原生 IPC 尚未连接'), { retcode: 1502 })); return; }
        if (pending.size >= 32 || authenticated.writableLength > 1024 * 1024) { reject(Object.assign(new Error('动作队列已满，未提交'), { retcode: 1503 })); return; }
        const id = randomBytes(16).toString('hex');
        const frame = JSON.stringify({ type: 'action', id, request }) + '\n';
        if (Buffer.byteLength(frame) > 1024 * 1024) { reject(Object.assign(new Error('动作帧超过 1 MiB，未提交'), { retcode: 1400 })); return; }
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('IPC 动作超时；已提交的发送结果未确认，请勿自动重试'), { retcode: 1501 }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        authenticated.write(frame);
      });
    },
    async close() {
      failPending();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      if (allocated.ownedDir) rmSync(allocated.ownedDir, { recursive: true, force: true });
      else if (!isWindowsPipe) rmSync(path, { force: true });
    },
  };
}
