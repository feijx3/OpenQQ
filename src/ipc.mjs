import { createConnection, createServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PIPE_PREFIX = '\\\\.\\pipe\\openqq-';
const SOCKET_PREFIX = 'openqq-';

// 端点名每次都随机。之所以不用「由项目路径算哈希」那种可推导的名字：那样本机任何进程都能
// 预先算出名字、在 OpenQQ 没运行时先占住它，从而收到 QQ 侧 hello 帧里的令牌，并往下发 action。
// 随机名连同令牌一起持久化在 .runtime/ipc.json，同一份安装下次启动仍然落到同一个地址，
// 这才是「重启 OpenQQ 不用重启 QQ」的前提。
export function allocateChannelPath() {
  const id = randomBytes(16).toString('hex');
  if (process.platform === 'win32') return { path: `${PIPE_PREFIX}${id}` };
  // socket 放在 0700 的专属目录里，而不是直接摊在 /tmp：/tmp 对其他用户可读，随机名字会暴露，
  // 在「OpenQQ 重启删掉 socket、QQ 侧还在每 300ms 重连 hello」的窗口里同机其他用户可能抢占路径拿令牌。
  // 目录名同样随机，权限 0700 —— 别人连枚举都做不到。
  const dir = join(tmpdir(), `${SOCKET_PREFIX}${id}`);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 建不出来就走下面的回退 */ }
  const preferred = join(dir, 'openqq.sock');
  // Unix domain socket 的 sun_path 上限通常是 104~108 字节，太长 listen 会失败，退到 /tmp 下的同名目录。
  if (Buffer.byteLength(preferred) <= 100) return { path: preferred };
  const fallbackDir = join('/tmp', `${SOCKET_PREFIX}${id}`);
  try { mkdirSync(fallbackDir, { recursive: true, mode: 0o700 }); } catch { /* 同上 */ }
  return { path: join(fallbackDir, 'openqq.sock') };
}

// 端点形状必须和当前平台一致：换了平台（或换了机器）时旧的 ipc.json 指向一个本机根本不存在的
// 地址，按首次注入处理，免得拿着它白等 6 秒。
export function matchesPlatform(pipe) {
  if (typeof pipe !== 'string' || pipe.length === 0) return false;
  if (process.platform === 'win32') return pipe.startsWith(PIPE_PREFIX) && pipe.length > PIPE_PREFIX.length;
  return pipe.startsWith('/') && pipe.endsWith('.sock');
}

export function readIpcParams(runtimeDir) {
  try {
    const saved = JSON.parse(readFileSync(join(runtimeDir, 'ipc.json'), 'utf8'));
    if (!matchesPlatform(saved?.pipe)) return null;
    if (typeof saved?.token !== 'string' || saved.token.length < 32) return null;
    return { pipe: saved.pipe, token: saved.token };
  } catch {
    return null;
  }
}

export function ensureIpcParams(runtimeDir) {
  const saved = readIpcParams(runtimeDir);
  if (saved) return saved;
  const fresh = { pipe: allocateChannelPath().path, token: randomBytes(32).toString('hex') };
  try {
    mkdirSync(runtimeDir, { recursive: true });
    const file = join(runtimeDir, 'ipc.json');
    writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
    // 文件已存在时 mode 参数不生效，补一次 chmod。Windows 上 0o600 是 no-op ——
    // 那里的访问控制靠命名管道本身的 ACL（创建者与 SYSTEM/Administrators），见 README 的说明。
    chmodSync(file, 0o600);
  } catch {
    // 写不进去就本次内生效，下次重新生成；端点仍然是随机的，不会退化成可预测的名字。
  }
  return fresh;
}

// 上次异常退出可能留下 socket 文件。先探一下有没有人真的在听，确认没人再删，
// 避免把另一个正在服务的实例的端点删掉。
export function clearStaleSocket(path) {
  try {
    if (!statSync(path).isSocket()) return Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const probe = createConnection(path);
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', err => {
      // 只有 ECONNREFUSED 能证明「文件还在但没人听」。EACCES / EPERM 之类说明我们连判断的权限都没有，
      // 这时删文件可能误伤另一个正在服务的实例，宁可让后面的 listen 自己去报 EADDRINUSE。
      if (err && err.code !== 'ECONNREFUSED') { resolve(false); return; }
      try { unlinkSync(path); } catch { /* 删不掉就让 listen 报 EADDRINUSE */ }
      resolve(true);
    });
  });
}

export async function createNativeChannel(customPath, customToken) {
  const path = customPath ?? allocateChannelPath().path;
  const isWindowsPipe = process.platform === 'win32' || path.startsWith('\\\\.\\pipe\\');
  // 固定端点可能残留上次的 socket 文件，listen 前先清掉（Windows 命名管道没有这个问题）。
  if (!isWindowsPipe) await clearStaleSocket(path);
  const events = new EventEmitter();
  const token = typeof customToken === 'string' && customToken.length >= 32 ? customToken : randomBytes(32).toString('hex');
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
      // 允许同一端点被下一次连接重新认证；否则 QQ 侧断线重连会被「已认证」挡掉。
      if (authenticated === socket) authenticated = null;
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
      if (!isWindowsPipe) rmSync(path, { force: true });
    },
  };
}
