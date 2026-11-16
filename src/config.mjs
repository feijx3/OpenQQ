import { randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { isUncPath } from './env.mjs';

export function defaultConfig(detected = {}) {
  const defaultRoot = process.platform === 'win32' ? 'C:\\Program Files\\Tencent\\QQNT' : '/opt/QQ';
  return {
    version: 1,
    qqRoot: detected.qqRoot || process.env.OPENQQ_QQ_ROOT || defaultRoot,
    webPort: 17860,
    accessToken: randomBytes(32).toString('hex'),
    // Inside a container the published port only reaches a socket bound to 0.0.0.0 (the Dockerfile sets OPENQQ_WS_HOST).
    ws: { enabled: true, host: ['127.0.0.1', '0.0.0.0'].includes(process.env.OPENQQ_WS_HOST) ? process.env.OPENQQ_WS_HOST : '127.0.0.1', port: 3001 },
    reverseWs: [],
  };
}

export function validateConfig(value) {
  const fail = message => { throw new Error(message); };
  if (!value || value.version !== 1) fail('配置版本必须为 1');
  if (typeof value.qqRoot !== 'string' || !value.qqRoot.trim() || value.qqRoot.length > 4096 || /[\0\r\n]/.test(value.qqRoot) || isUncPath(value.qqRoot)) {
    fail('qqRoot 路径无效');
  }
  const port = n => Number.isInteger(n) && n >= 1 && n <= 65535;
  if (!port(value.webPort)) fail('WebUI 端口必须为 1..65535');
  if (typeof value.accessToken !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(value.accessToken)) fail('OneBot 令牌需要 16..256 位非空格 ASCII 字符');
  if (!value.ws || typeof value.ws.enabled !== 'boolean' || !['127.0.0.1', '0.0.0.0'].includes(value.ws.host) || !port(value.ws.port)) fail('WebSocket 服务端配置无效');
  if (value.ws.enabled && value.ws.port === value.webPort) fail('WebUI 和 WebSocket 端口不能相同');
  if (!Array.isArray(value.reverseWs) || value.reverseWs.length > 8) fail('最多配置 8 个反向 WebSocket');
  const reverseWs = value.reverseWs.map(item => {
    if (!item || typeof item.enabled !== 'boolean' || typeof item.url !== 'string' || item.url.length > 2048) fail('反向 WebSocket 配置无效');
    let url; try { url = new URL(item.url); } catch { fail('反向 WebSocket URL 无效'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail('反向 URL 需为 ws:// 或 wss://，令牌请填入令牌字段');
    if (typeof item.token !== 'string' || !/^[\x21-\x7e]{0,256}$/.test(item.token)) fail('反向令牌格式无效');
    return { enabled: item.enabled, url: url.href, token: item.token };
  });
  if (!value.ws.enabled && !reverseWs.some(item => item.enabled)) fail('请至少启用一个 WebSocket 接入');
  return {
    version: 1,
    qqRoot: value.qqRoot.trim(),
    webPort: value.webPort,
    accessToken: value.accessToken,
    ws: { enabled: value.ws.enabled, host: value.ws.host, port: value.ws.port },
    reverseWs,
  };
}

export function readConfig(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return validateConfig(JSON.parse(text)); } catch (error) { throw new Error('配置读取失败：' + error.message); }
}

export function saveConfig(path, value) {
  const config = validateConfig(value);
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
  return config;
}
