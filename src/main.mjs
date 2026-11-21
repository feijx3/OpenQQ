import { parseArgs } from 'node:util';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, readFileSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { inspectQQ, resolveLinuxWrapper, bootstrapInput, verifiedVersions } from './qq.mjs';
import { detectEnvironment, isQQProcessRunning, probeNative } from './env.mjs';
import { createNativeChannel, ensureIpcParams } from './ipc.mjs';
import { createEventConverter } from './onebot.mjs';
import { createIdStore } from './idstore.mjs';
import { dispatchAction, redactRequest, redactResponse } from './actions.mjs';
import { createMediaPreparer } from './media.mjs';
import { startCommandInput, inputHelp } from './input.mjs';
import { createConsole } from './console.mjs';
import { startWebUI } from './webui.mjs';
import { defaultConfig, readConfig, saveConfig } from './config.mjs';
import { setupCLI } from './setup.mjs';
import { startOneBot } from './network.mjs';
import { createBotStore } from './bot/store.mjs';
import { createAIClient } from './bot/ai.mjs';
import { createImageClient } from './bot/image.mjs';
import { createBotEngine } from './bot/engine.mjs';
import { createBotApi } from './bot/api.mjs';

// 运行中的 QQ 里有没有我们的原生模块。QQ 允许多开、各账号分区独立，所以机器上同时开着
// 别的账号的 QQ 是正常情况——那不是"附着失败"，而是"该另起一个实例"。
// 查不出来时按"是我们的"处理，保持原来更保守的行为。
function runningQQIsOurs() {
  if (process.platform !== 'win32') return true;
  try {
    const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const out = execFileSync(ps, [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-Process QQ -ErrorAction SilentlyContinue | ForEach-Object { try { if ($_.Modules | Where-Object { $_.ModuleName -like '*openqq-bootstrap*' }) { 'openqq' } } catch {} }",
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out).includes('openqq');
  } catch {
    return true;
  }
}

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
// 生图客户端只有一个：WebUI 的生图页和 OneBot 的 generate_image 动作共用它，所以同一时间只会有一个生成任务。
const botImage = createImageClient({ settings: () => botStore.readImage() });
const botApi = createBotApi({ store: botStore, engine: botEngine, ai: botAI, image: botImage });
for (const item of botStore.skipped) out.log('warn', `Bot ${item.id} 无法载入：${item.error}`);

function checkClient(qq) {
  const supportedHost = (process.platform === 'win32' && process.arch === 'x64')
    || (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch));
  if (!supportedHost || qq.platform !== process.platform || qq.arch !== process.arch || !qq.supported) {
    throw new Error('当前仅支持 Windows x64 与 Linux x64/arm64 QQ NT（需包含 qq_magic_napi_register 与 N-API 导出）');
  }
  const native = probeNative(projectDir);
  if (!native.ready) throw new Error(native.error);
  // 这里不判断 QQ 是否在运行：在运行也可能是一个已经注入了原生脚本的实例，那样只需附着。
  // 到底能不能附着由 start() 里「等它连回固定端点」这一步决定，失败时再给出退出 QQ 的提示。
  return native;
}

// The startup banner's OneBot line: every way a bot can reach OpenQQ.
function oneBotAccess(config) {
  const parts = [config.ws.enabled && `ws://${config.ws.host}:${config.ws.port}`, config.http?.enabled && `http://${config.http.host}:${config.http.port}`,
    config.reverseWs.some(item => item.enabled) && '反向 WS', config.httpPost?.some(item => item.enabled) && 'HTTP 上报'].filter(Boolean);
  return parts.join(' · ') + (config.ws.enabled || config.http?.enabled ? '（令牌见 WebUI 接入配置）' : '：QQ 就绪后连接');
}

// ipc.json 的读取与生成在 src/ipc.mjs（ensureIpcParams）：端点名是随机的，只持久化复用，
// 不由项目路径推导。这样同一份安装下次启动仍落到同一地址，别的进程却猜不到名字。

async function start(qq, config, existingWebUI) {
  const native = checkClient(qq);
  if (!qq.targetMatch) {
    out.log('warn', `当前 QQ 版本 ${qq.version} 未经过完整实机验证（已验证版本：${verifiedVersions.join('、')}），如遇异常请查看运行诊断`);
  }
  let current = { phase: 'starting', version: qq.version, bootstrap: 'cpp-native' };
  const ipcParams = ensureIpcParams(runtimeDir);
  const channel = await createNativeChannel(ipcParams.pipe, ipcParams.token);
  // 优先附着：QQ 已在运行、且里面那份原生脚本还在（它会自己连回固定端点）时，等它连回来，完全不碰 QQ。
  // 连不回来就说明那个 QQ 不是我们注入的实例。这时既不能附着，也不能再拉一个启动器（会往一个已经
  // 跑着的 QQ 里重复注入），只能请用户先退出 QQ —— 也就是改造前那条原始错误的含义。
  let attached = false;
  if (isQQProcessRunning()) {
    out.log('info', '检测到 QQ 正在运行，尝试直接附着（不重启 QQ）…');
    attached = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 6000);
      channel.events.once('connected', info => {
        clearTimeout(timer);
        current = { ...current, phase: 'hook_installed', pid: info.pid };
        resolve(true);
      });
    });
    if (!attached) {
      // 附着不上有两种完全不同的原因，不能一律报"请先退出 QQ"：
      //  · 运行中的 QQ 里装着我们的原生模块 → 那是同一个实例但端点没连回来（真异常）。
      //  · 运行中的 QQ 是另一个账号（QQ 允许多开，各账号分区独立）→ 它根本不是我们的目标，
      //    另起一个实例才是对的。多账号机器上很常见，不该要求用户把自己的 QQ 关掉。
      if (runningQQIsOurs()) {
        await channel.close();
        throw new Error('请先手动退出 QQ，再由 OpenQQ 在原生模块加载前启动挂接');
      }
      out.log('info', '运行中的 QQ 不是 OpenQQ 注入的实例（另一个账号），将以独立实例启动');
    }
    if (attached) out.log('info', '已附着到运行中的 QQ（QQ 没有被重启）');
  }
  let network;
  // message_id values survive a restart: the mapping to QQ's own ids is kept in .runtime/ids.json.
  const convert = createEventConverter({ mediaUrl: (filePath, fileName) => network?.mediaUrl(filePath, fileName) ?? null,
    idStore: createIdStore(join(runtimeDir, 'ids.json')) });
  // Sources of image / voice / video / file segments (local path, base64, URL) are fetched into this folder before sending.
  const media = createMediaPreparer({ dir: join(runtimeDir, 'media') });
  media.sweep().catch(() => {});
  let webui;
  const execute = async (request, source) => {
    const started = performance.now();
    const response = await dispatchAction(channel, convert, request, {
      media, image: botImage, version: pkg.version, mediaUrl: (filePath, fileName) => network?.mediaUrl(filePath, fileName) ?? null,
    });
    // The WebUI and the terminal get a copy without inline media, so a large image is still listed instead of being dropped.
    const shown = redactRequest(request);
    const shownResponse = redactResponse(response);
    webui?.publish('action', { request: shown, response: shownResponse, source, elapsed: Math.round(performance.now() - started) });
    // Terminal actions are printed by the input loop; external actions are mirrored here.
    if (source !== 'terminal') out.action(shown, shownResponse, source);
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
    ['OneBot', oneBotAccess(config)], ['QQ 原始日志', qqLogPath]]);
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
  let driver = null;
  if (!attached) {
    const driverEnv = values['no-sandbox'] ? { ...process.env, OPENQQ_QQ_NO_SANDBOX: '1' } : process.env;
    driver = spawn(native.launcher, [], {
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
  }
  const terminal = out.pretty && Boolean(process.stdin.isTTY);
  const input = startCommandInput({
    terminal, output: process.stdout, prompt: promptFor(out.paint, current),
    dispatch: request => execute(request, 'terminal'), onQuit: finish,
    respond: (request, response) => out.action(request, response, 'terminal'),
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
    // 附着模式下没有 driver（QQ 不是本进程拉起的），要跳过对它的收尾。
    if (driver) {
      driver.stdin.end('stop\n');
      // QQ keeps its log handles after bootstrap; release our ends so quitting can exit Node.
      driver.stdout.destroy();
      driver.stderr.destroy();
      driver.unref();
    }
    botDispatch = async () => ({ status: 'failed', retcode: 1502, data: null, message: 'QQ 尚未就绪' });
    botLog = () => {};
    await channel.close();
    convert.flush();
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
