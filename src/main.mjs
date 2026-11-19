import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, readFileSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { inspectQQ, resolveLinuxWrapper, bootstrapInput, verifiedVersions } from './qq.mjs';
import { detectEnvironment, isQQProcessRunning, probeNative } from './env.mjs';
import { createNativeChannel } from './ipc.mjs';
import { createEventConverter } from './onebot.mjs';
import { dispatchAction, recordAction, redactActionResponse } from './actions.mjs';
import { createMediaPreparer } from './media.mjs';
import { startCommandInput, inputHelp } from './input.mjs';
import { createConsole } from './console.mjs';
import { startWebUI } from './webui.mjs';
import { defaultConfig, readConfig, saveConfig } from './config.mjs';
import { setupCLI } from './setup.mjs';
import { startOneBot } from './network.mjs';
import { createBotStore } from './bot/store.mjs';
import { createAIClient } from './bot/ai.mjs';
import { createBotEngine } from './bot/engine.mjs';
import { createBotApi } from './bot/api.mjs';

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDir = join(projectDir, '.runtime');
// Bot 的数据（积木程序、记忆、AI 设置和 Key）放在 data/bot，不放在会被清理的 .runtime 里；容器部署请挂载这个目录。
const dataDir = process.env.OPENQQ_DATA_DIR ? resolve(process.env.OPENQQ_DATA_DIR) : join(projectDir, 'data');
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'qq-root': { type: 'string' },
  'web-port': { type: 'string' },
  'web-host': { type: 'string' },
  'no-sandbox': { type: 'boolean', default: false },
  config: { type: 'string', default: join(projectDir, 'config', 'openqq.json') },
  json: { type: 'boolean', default: false },
  verbose: { type: 'boolean', default: false },
} });
const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
// A terminal gets the readable view; a pipe (or --json) keeps OneBot JSON Lines on stdout.
const out = createConsole({ mode: values.json || !process.stdout.isTTY ? 'json' : 'pretty', verbose: values.verbose });

function status(value) {
  mkdirSync(runtimeDir, { recursive: true });
  const path = join(runtimeDir, 'status.json');
  writeFileSync(path + '.tmp', JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(path + '.tmp', path);
}

const promptLabels = { starting: '启动中', hook_installed: '等待登录', session_ready: '同步中', offline: '已掉线', hook_error: '接入异常' };
function promptFor(paint, state) {
  if (state.phase === 'session_ready' && !state.syncing) return `${paint('green bold', '●')} ${paint('bold', state.self_id)} ${paint('cyan bold', '›')} `;
  const label = Object.hasOwn(promptLabels, state.phase) ? promptLabels[state.phase] : state.phase;
  const style = ['offline', 'hook_error'].includes(state.phase) ? 'red bold' : 'yellow bold';
  return `${paint(style, '○')} ${paint('gray', label)} ${paint('cyan bold', '›')} `;
}

// 图形化 Bot：存储、AI 客户端和引擎在进程启动时创建一次。引擎发送消息用的 dispatch 在 QQ 挂接成功后才接上；
// 没挂接时（配置向导/预览模式）WebUI 仍然能编辑积木、记忆和 AI 设置，只是不会收到消息。
let botDispatch = async () => ({ status: 'failed', retcode: 1502, data: null, message: 'QQ 尚未就绪' });
let botLog = () => {};
const botStore = createBotStore({ dir: join(dataDir, 'bot') });
const botAI = createAIClient({ settings: () => botStore.readAi() });
const botEngine = createBotEngine({ store: botStore, ai: botAI, dispatch: request => botDispatch(request), log: entry => botLog(entry) });
const botApi = createBotApi({ store: botStore, engine: botEngine, ai: botAI });
for (const item of botStore.skipped) out.log('warn', `Bot ${item.id} 无法载入：${item.error}`);

function checkClient(qq) {
  const supportedHost = (process.platform === 'win32' && process.arch === 'x64')
    || (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch));
  if (!supportedHost || qq.platform !== process.platform || qq.arch !== process.arch || !qq.supported) {
    throw new Error('当前仅支持 Windows x64 与 Linux x64/arm64 QQ NT（需包含 qq_magic_napi_register 与 N-API 导出）');
  }
  const native = probeNative(projectDir);
  if (!native.ready) throw new Error(native.error);
  if (isQQProcessRunning()) throw new Error('请先手动退出 QQ，再由 OpenQQ 在原生模块加载前启动挂接');
  return native;
}

async function start(qq, config, existingWebUI) {
  const native = checkClient(qq);
  if (!qq.targetMatch) {
    out.log('warn', `当前 QQ 版本 ${qq.version} 未经过完整实机验证（已验证版本：${verifiedVersions.join('、')}），如遇异常请查看运行诊断`);
  }
  const channel = await createNativeChannel();
  let network;
  const convert = createEventConverter({ mediaUrl: (filePath, fileName) => network?.mediaUrl(filePath, fileName) ?? null });
  // Sources of image / voice / video / file segments (local path, base64, URL) are fetched into this folder before sending.
  const media = createMediaPreparer({ dir: join(runtimeDir, 'media') });
  media.sweep().catch(() => {});
  let current = { phase: 'starting', version: qq.version, bootstrap: 'cpp-native' };
  let webui;
  const execute = async (request, source) => {
    const started = performance.now();
    const response = await dispatchAction(channel, convert, request, {
      media, version: pkg.version, mediaUrl: (filePath, fileName) => network?.mediaUrl(filePath, fileName) ?? null,
    });
    recordAction(webui, out, { request, response, source, elapsed: Math.round(performance.now() - started) });
    return response;
  };
  try {
    webui = existingWebUI ?? await configurationWebUI(config, true);
    webui.setDispatch(request => execute(request, 'webui'));
    botDispatch = request => execute(request, 'bot');
    // 只有出错或被限流的运行才进入事件流/终端；成功的运行记录在 WebUI 的 Bot 页面里查看。
    botLog = entry => {
      if (entry.status === 'ok') return;
      webui.publish('diagnostic', { type: 'bot_run', ...entry });
      out.log('warn', `Bot「${entry.botName}」${entry.status === 'limited' ? '被限流' : '运行出错'}：${entry.error}`);
    };
    network = await startOneBot({ config, dispatch: request => execute(request, 'onebot'), onStatus: networkState => {
      current = { ...current, network: networkState }; webui.setStatus(current);
    } });
  }
  catch (error) { await channel.close(); throw error; }
  const saveStatus = () => {
    status(current);
    webui.setStatus(current);
    network.setStatus(current);
    out.setPrompt(promptFor(out.paint, current));
  };
  saveStatus();
  const qqLogPath = join(runtimeDir, 'qq.log');
  const qqLog = createWriteStream(qqLogPath, { flags: 'w' });
  qqLog.on('error', () => {});
  out.banner(`OpenQQ ${pkg.version}`, [['QQ 版本', qq.version], ['WebUI', webui.url],
    ['OneBot', config.ws.enabled ? `ws://${config.ws.host}:${config.ws.port}（令牌见 WebUI 接入配置）` : '反向 WS：QQ 就绪后连接'], ['QQ 原始日志', qqLogPath]]);
  let finish;
  let reject;
  const stopped = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
  const startupTimeout = setTimeout(() => reject(new Error('原生脚本未在 35 秒内连接 IPC；请查看上方原生引导日志')), 35000);
  const onSignal = () => finish();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  channel.events.on('connected', ({ pid }) => {
    clearTimeout(startupTimeout);
    current = { ...current, phase: 'hook_installed', pid };
    saveStatus();
    out.log('ok', `原生脚本已载入 QQ（PID ${pid}），请在 QQ 窗口正常登录`);
  });
  channel.events.on('event', event => {
    try {
      if (['message', 'notice', 'request'].includes(event.type)) {
        const converted = convert(event);
        if (converted) {
          out.event(converted);
          webui.publish('event', converted);
          network.broadcast(converted);
          // 同步历史消息期间不让 Bot 回复，避免对旧消息做出反应。
          if (current.phase === 'session_ready' && !current.syncing) botEngine.handleEvent(converted).catch(() => {});
        }
      } else {
        webui.publish('diagnostic', event);
        if (event.type === 'session_ready') current = { ...current, phase: 'session_ready', self_id: event.self_id, services: event.services };
        if (event.type === 'offline') current = { ...current, phase: 'offline' };
        if (event.type === 'hook_error') current = { ...current, phase: 'hook_error', error: event.error, stage: event.stage };
        if (event.type === 'sync_state') current = { ...current, syncing: event.syncing };
        if (['session_ready', 'offline', 'hook_error', 'sync_state'].includes(event.type)) saveStatus();
        out.diagnostic(event);
        if (event.type === 'session_ready') {
          out.banner('✔ QQ 会话就绪', [['账号', event.self_id], ['监听服务', event.services.join(' · ')],
            ['命令', '/help 查看命令 · Tab 补全 · ↑↓ 历史']], 'green');
          const hidden = out.takeHidden();
          if (hidden && out.pretty) out.log('info', `已隐藏 ${hidden} 条调试信息；输入 /verbose 显示后续调试信息`);
        }
      }
    } catch (error) {
      out.log('warn', '事件未转换：' + error.message);
      webui.publish('diagnostic', { type: 'event_error', stage: 'convert', error: error.message });
    }
  });
  channel.events.once('disconnected', finish);
  channel.events.on('failure', reject);
  const driverEnv = values['no-sandbox'] ? { ...process.env, OPENQQ_QQ_NO_SANDBOX: '1' } : process.env;
  const driver = spawn(native.launcher, [], {
    windowsHide: true, env: driverEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const wrapper = resolveLinuxWrapper(qq);
  // Keep IPC token and pipe path out of process command-line arguments.
  driver.stdin.write(bootstrapInput({ executable: qq.executable, wrapper, dll: native.dll,
    payload: join(projectDir, 'native/session.cjs'), pipe: channel.path, token: channel.token }));
  // QQ inherits the bootstrap's stdio, so its own console output arrives here as well: keep all of it in
  // .runtime/qq.log and show only OpenQQ's bootstrap stages (QQ lines appear with /verbose).
  for (const stream of [driver.stdout, driver.stderr]) {
    stream.on('data', chunk => { if (!qqLog.writableEnded) qqLog.write(chunk); });
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => out.native(line));
  }
  driver.stdin.on('error', () => {});
  driver.once('error', reject);
  driver.once('exit', (code, signal) => {
    if (code !== 0) reject(new Error(`原生引导器退出（${signal ?? code}）；请查看上方原生引导日志`));
  });
  out.log('info', `以正常参数启动 QQ ${qq.version}（独立原生挂接，无 Inspector 端口）`);
  const terminal = out.pretty && Boolean(process.stdin.isTTY);
  const input = startCommandInput({
    terminal, output: process.stdout, prompt: promptFor(out.paint, current),
    dispatch: request => execute(request, 'terminal'), onQuit: finish,
    respond: (request, response) => out.action(request, out.pretty ? redactActionResponse(response) : response, 'terminal'),
    help: () => out.help(inputHelp),
    local: {
      clear: () => { if (out.pretty) process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); },
      verbose: () => out.log('info', out.toggleVerbose() ? '已显示调试信息与 QQ 原始日志' : '已隐藏调试信息与 QQ 原始日志'),
    },
  });
  if (terminal) out.attach(input.reader);
  input.done.catch(reject);
  try { await stopped; }
  catch (error) { current = { ...current, phase: 'failed', error: error.message }; throw error; }
  finally {
    clearTimeout(startupTimeout);
    input.close();
    driver.stdin.end('stop\n');
    // QQ keeps its log handles after bootstrap; release our ends so quitting can exit Node.
    driver.stdout.destroy();
    driver.stderr.destroy();
    driver.unref();
    botDispatch = async () => ({ status: 'failed', retcode: 1502, data: null, message: 'QQ 尚未就绪' });
    botLog = () => {};
    await channel.close();
    await network.close();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    current = current.phase === 'failed' ? current : { phase: 'detached', version: qq.version };
    saveStatus();
    await webui.close();
    qqLog.end();
    if (current.phase === 'detached') out.log('info', '已解除挂接，QQ 可以继续运行');
  }
}

let savedConfig;
let startFromWeb;
let webRunning = false;
const webHost = values['web-host'] ?? process.env.OPENQQ_WEB_HOST ?? '127.0.0.1';
const webAllowedHosts = (process.env.OPENQQ_WEB_ALLOW_HOSTS ?? '').split(',').map(item => item.trim()).filter(Boolean);

async function configurationWebUI(config, running = false) {
  webRunning = running;
  let webui;
  webui = await startWebUI({ port: Number(values['web-port'] ?? config.webPort), host: webHost, allowedHosts: webAllowedHosts, bot: botApi,
    status: { phase: savedConfig ? 'detached' : 'setup' }, configuration: {
    get: () => {
      const currentConfig = savedConfig ?? config;
      const detected = detectEnvironment({ projectDir, qqRoot: currentConfig.qqRoot });
      return { config: currentConfig, initialized: Boolean(savedConfig), running: webRunning, configPath: values.config, detected };
    },
    check: value => {
      const qqRoot = typeof value?.qqRoot === 'string' ? value.qqRoot.trim() : '';
      return detectEnvironment({ projectDir, qqRoot });
    },
    save: value => {
      savedConfig = saveConfig(values.config, value);
      return { config: savedConfig, restartRequired: webRunning, message: webRunning ? '配置已保存，下次启动生效；当前连接继续使用原配置。' : '配置已保存，点击「启动 OpenQQ」即可开始。' };
    },
    start: () => {
      if (webRunning || !startFromWeb) throw new Error('框架已启动；配置修改后请在终端重启 npm start');
      if (!savedConfig) throw new Error('请先完成配置并保存');
      const qq = inspectQQ(savedConfig.qqRoot);
      checkClient(qq);
      // Clear 'setup' phase before the browser navigates to '/' so it is not bounced back to '/setup'.
      webui.setStatus({ phase: 'starting', version: qq.version, bootstrap: 'cpp-native' });
      webRunning = true;
      startFromWeb(savedConfig);
      return { message: '正在启动，请在 QQ 窗口登录，并返回会话控制台查看状态。' };
    },
  } });
  return webui;
}

async function configureInBrowser(config) {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; startFromWeb = resolve; });
  const webui = await configurationWebUI(config);
  out.banner('OpenQQ 初始化与接入配置', [['地址', webui.url.replace('/#', '/setup#')], ['配置文件', values.config], ['退出', 'Ctrl+C']]);
  const stop = () => finish(null);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let selected;
  try { selected = await pending; }
  finally { startFromWeb = null; process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  if (!selected) { await webui.close(); return; }
  try { await start(inspectQQ(selected.qqRoot), selected, webui); }
  finally { await webui.close(); }
}

try {
  if (values['web-port'] !== undefined && (!/^\d+$/.test(values['web-port']) || Number(values['web-port']) > 65535)) throw new Error('--web-port 必须为 0..65535 的整数');
  if (!['127.0.0.1', '0.0.0.0'].includes(webHost)) throw new Error('--web-host 仅支持 127.0.0.1 或 0.0.0.0');
  const command = positionals[0] ?? 'doctor';
  savedConfig = readConfig(values.config);
  const detectedForDefault = savedConfig ? null : detectEnvironment({ projectDir, qqRoot: values['qq-root'] });
  const config = savedConfig ?? defaultConfig({ qqRoot: detectedForDefault?.qq?.path });
  if (values['qq-root']) config.qqRoot = values['qq-root'];
  if (values['web-port'] && Number(values['web-port'])) config.webPort = Number(values['web-port']);
  if (command === 'init') await setupCLI(values.config, config);
  else if (command === 'webui' || (command === 'start' && !savedConfig)) await configureInBrowser(config);
  else if (command === 'doctor') {
    const env = detectEnvironment({ projectDir, qqRoot: values['qq-root'] ?? savedConfig?.qqRoot });
    let inspected = null;
    if (env.qq?.path) {
      try { inspected = inspectQQ(env.qq.path); } catch (error) { inspected = { error: error.message }; }
    }
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, detected: env, qq: inspected }, null, 2));
  }
  else if (command === 'start') {
    let webui;
    try { webui = await configurationWebUI(config, true); await start(inspectQQ(config.qqRoot), config, webui); }
    finally { await webui?.close(); }
  }
  else throw new Error('用法: npm run init、npm run webui、npm run doctor 或 npm start');
} catch (error) { out.log('error', error.message); process.exitCode = 1; }
finally { botEngine.close(); }
