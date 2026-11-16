import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';

// Client-side routes of the single-page console; each one serves index.html.
const pages = ['/', '/messages', '/events', '/actions', '/logs', '/account', '/connections', '/settings'];
const files = new Map([
  ...pages.map(path => [path, ['index.html', 'text/html; charset=utf-8']]),
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['app.css', 'text/css; charset=utf-8']],
  ['/theme.css', ['theme.css', 'text/css; charset=utf-8']],
  ['/fonts/inter.woff2', ['fonts/inter.woff2', 'font/woff2']],
  ['/fonts/mono.woff2', ['fonts/mono.woff2', 'font/woff2']],
  ['/logo.svg', ['logo.svg', 'image/svg+xml']],
  ['/setup', ['setup.html', 'text/html; charset=utf-8']],
]);
const limit = 2 * 1024 * 1024;
const minute = 60000;

// Per-minute throughput, action latency and bridge-process usage for /api/metrics. Everything is in memory.
function createMetrics() {
  const startedAt = Date.now();
  const buckets = new Map();
  const latencies = [];
  let cpu = process.cpuUsage(), sampled = performance.now();
  function bucket(time = Date.now()) {
    const key = Math.floor(time / minute) * minute;
    let value = buckets.get(key);
    if (!value) {
      value = { minute: key, events: 0, actions: 0, errors: 0 }; buckets.set(key, value);
      for (const old of buckets.keys()) if (old <= key - 60 * minute) buckets.delete(old);
    }
    return value;
  }
  return {
    record(kind, failed, elapsed) {
      const value = bucket();
      if (kind === 'event') value.events++;
      if (kind === 'action') value.actions++;
      if (failed) value.errors++;
      if (kind === 'action' && Number.isFinite(elapsed) && elapsed >= 0) { latencies.push(elapsed); if (latencies.length > 200) latencies.shift(); }
    },
    snapshot() {
      const now = Date.now(), current = Math.floor(now / minute) * minute;
      const timeline = Array.from({ length: 60 }, (_, index) => {
        const key = current - (59 - index) * minute;
        return buckets.get(key) ?? { minute: key, events: 0, actions: 0, errors: 0 };
      });
      const usage = process.cpuUsage(cpu), wall = performance.now() - sampled;
      cpu = process.cpuUsage(); sampled = performance.now();
      const memory = process.memoryUsage();
      const sorted = [...latencies].sort((a, b) => a - b);
      return {
        startedAt: new Date(startedAt).toISOString(), uptime: Math.floor((now - startedAt) / 1000),
        process: { pid: process.pid, node: process.version, platform: process.platform, rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
          cpu: wall > 0 ? Math.min(100, (usage.user + usage.system) / 1000 / wall / availableParallelism() * 100) : 0 },
        latency: { samples: sorted.length, average: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
          p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null, last: latencies.at(-1) ?? null },
        timeline,
      };
    },
  };
}

export async function startWebUI({ port = 17860, host = '127.0.0.1', allowedHosts = [], status = { phase: 'detached' }, dispatch, configuration } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('WebUI 端口必须为 0..65535 的整数');
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('WebUI 监听地址仅支持 127.0.0.1 或 0.0.0.0');
  const token = randomBytes(32).toString('hex');
  const clients = new Set();
  const history = [];
  const counts = { events: 0, actions: 0, errors: 0 };
  let bytes = 0;
  let sequence = 0;
  let state = { ...status };
  let origin;
  let validHosts;
  let closing = false;
  let activeBodies = 0;
  let activeActions = 0;
  const metrics = createMetrics();
  const assets = new Map(await Promise.all([...files].map(async ([path, [name, type]]) => [path, { type,
    body: await readFile(new URL('../web/' + name, import.meta.url)),
  }])));

  function isAllowedRequest(request) {
    const reqHost = request.headers.host;
    if (!reqHost || !validHosts.has(reqHost)) return false;
    const reqOrigin = request.headers.origin;
    if (!reqOrigin) return true;
    if (host === '127.0.0.1') return reqOrigin === origin;
    try {
      const parsed = new URL(reqOrigin);
      return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === reqHost;
    } catch { return false; }
  }

  function json(response, code, data) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(data));
  }
  function frame(client, type, data) {
    if (client.writableLength > 4 * 1024 * 1024) { client.destroy(); return; }
    client.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }
  async function readJsonBody(request, response) {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => request.destroy(new Error('body_timeout')), 5000);
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 256 * 1024) { json(response, 413, { message: '动作内容超过 256 KiB' }); request.resume(); return undefined; }
        chunks.push(chunk);
      }
    } finally { clearTimeout(timer); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { json(response, 400, { message: '动作 JSON 无效' }); return undefined; }
  }
  const server = createServer((request, response) => {
    const styleNonce = randomBytes(16).toString('base64');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    if (closing || !isAllowedRequest(request)) {
      json(response, 403, { message: '仅允许本机同源访问' }); return;
    }
    if (!request.url || !request.url.startsWith('/') || request.url.startsWith('//')) {
      json(response, 400, { message: '请求地址无效' }); return;
    }
    let path;
    try { path = new URL(request.url, origin).pathname; }
    catch { json(response, 400, { message: '请求地址无效' }); return; }
    if (request.method === 'GET' && assets.has(path)) {
      const asset = assets.get(path);
      response.writeHead(200, { 'Content-Type': asset.type });
      response.end(asset.type.startsWith('text/html') ? asset.body.toString('utf8').replace('%OPENQQ_STYLE_NONCE%', styleNonce) : asset.body); return;
    }
    const authMatch = (request.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
    const supplied = Buffer.from(authMatch ? authMatch[1] : '');
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      json(response, 401, { message: '访问密钥无效，请使用终端显示的完整 WebUI 地址' }); return;
    }
    if (request.method === 'GET' && path === '/api/stream') {
      if (clients.size >= 8) { json(response, 429, { message: '打开的 WebUI 页面过多' }); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
      frame(response, 'snapshot', { state, counts, entries: history.map(item => item.entry) });
      clients.add(response);
      response.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'GET' && path === '/api/metrics') {
      json(response, 200, metrics.snapshot()); return;
    }
    if (request.method === 'GET' && path === '/api/config' && configuration) {
      json(response, 200, configuration.get()); return;
    }
    const postRoutes = ['/api/action', '/api/config', '/api/start', ...(configuration?.check ? ['/api/check'] : [])];
    if (request.method !== 'POST' || !postRoutes.includes(path) || (path !== '/api/action' && !configuration)) {
      json(response, 404, { message: '未找到入口' }); return;
    }
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
      json(response, 415, { message: '动作需要 application/json' }); return;
    }
    if (activeBodies >= 16 || activeActions >= 8) { json(response, 429, { message: '正在执行的动作过多' }); return; }
    if (Number(request.headers['content-length']) > 256 * 1024) { json(response, 413, { message: '动作内容超过 256 KiB' }); return; }
    activeBodies++;
    (async () => {
      let countedAction = false;
      try {
        const action = await readJsonBody(request, response);
        if (action === undefined) return;
        if (path !== '/api/action') {
          try {
            const result = path === '/api/config' ? await configuration.save(action)
              : path === '/api/check' ? await configuration.check(action)
              : await configuration.start();
            json(response, 200, result);
          } catch (error) { json(response, 400, { message: error.message }); }
          return;
        }
        if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.action !== 'string') {
          json(response, 400, { message: '需要 {action, params, echo?} 动作对象' }); return;
        }
        if (activeActions >= 8) { json(response, 429, { message: '正在执行的动作过多' }); return; }
        activeActions++;
        countedAction = true;
        const result = dispatch ? await dispatch(action)
          : { status: 'failed', retcode: 1502, data: null, message: '当前仅预览界面；请通过 npm start 接入 QQ' };
        if (!response.destroyed) json(response, 200, result);
      } catch {
        if (!response.headersSent && !response.destroyed) json(response, 500, { message: '动作执行异常，已提交的发送结果请在 QQ 中确认' });
      } finally {
        activeBodies--;
        if (countedAction) activeActions--;
      }
    })();
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const boundPort = server.address().port;
  origin = 'http://127.0.0.1:' + boundPort;
  validHosts = new Set([`127.0.0.1:${boundPort}`]);
  if (host === '0.0.0.0') {
    validHosts.add(`localhost:${boundPort}`);
    validHosts.add(`[::1]:${boundPort}`);
    for (const item of allowedHosts) {
      const value = String(item ?? '').trim();
      if (!value) continue;
      const hasPort = value.startsWith('[') ? /\]:\d+$/.test(value) : /:\d+$/.test(value);
      validHosts.add(hasPort ? value : `${value}:${boundPort}`);
    }
  }
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.writableLength > 4 * 1024 * 1024) client.destroy();
      else client.write(': heartbeat\n\n');
    }
  }, 15000);
  heartbeat.unref();
  return {
    origin, url: origin + '/#token=' + token,
    setDispatch(value) { dispatch = value; },
    setStatus(value) {
      state = { ...value };
      for (const client of clients) frame(client, 'state', state);
    },
    publish(kind, data) {
      if (closing) return;
      const entry = { id: ++sequence, kind, time: new Date().toISOString(), data };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (size > limit) return;
      const failed = (kind === 'action' && data.response?.status === 'failed') || (kind === 'diagnostic' && ['event_error', 'hook_error'].includes(data.type));
      if (kind === 'event') counts.events++;
      if (kind === 'action') counts.actions++;
      if (failed) counts.errors++;
      metrics.record(kind, failed, data?.elapsed);
      history.push({ entry, size }); bytes += size;
      while (history.length > 200 || bytes > limit) bytes -= history.shift().size;
      for (const client of clients) frame(client, 'entry', { entry, counts });
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await stopped;
    },
  };
}
