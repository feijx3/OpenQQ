import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CircleAlert, CircleCheck, Copy, Plus, RefreshCw, Terminal, Trash2, TriangleAlert } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { request } from '../lib/api';
import { forwardAddress, portError, reverseUrlError, tokenError } from '../lib/config';
import { usePreferences } from '../lib/preferences';
import { navigate } from '../lib/router';
import { cn, randomHex } from '../lib/utils';
import type { ConfigResponse, Detected, OpenQQConfig } from '../lib/types';
import { Brand } from '../components/brand';
import { DescriptionList, ErrorState } from '../components/page';
import { Button } from '../components/ui/button';
import { Field, Input, SecretInput, Switch } from '../components/ui/form';
import { Skeleton } from '../components/ui/misc';
import { Select } from '../components/ui/select';
import { copyText } from '../components/ui/toast';
import { Moon, Sun } from 'lucide-react';

const steps = [
  ['开始之前', '检查本机环境。启动桥接前，请先完全退出正在运行的 QQ。'],
  ['客户端', '确认 QQ NT 安装目录和 C++ 原生引导器。'],
  ['连接方式', '选择机器人与 OpenQQ 的通信方式，可以同时启用。'],
  ['访问密钥', '机器人端需要填写相同的 Access Token。'],
  ['确认配置', '确认无误后保存到本机配置文件。'],
  ['完成', '配置已保存，可以启动 OpenQQ 并连接机器人。'],
] as const;
type Mode = 'forward' | 'reverse' | 'both';
const modes: { value: Mode; title: string; note: string }[] = [
  { value: 'forward', title: '正向 WebSocket', note: 'OpenQQ 作为服务端，机器人主动连接。适合自写 Bot。' },
  { value: 'reverse', title: '反向 WebSocket', note: 'OpenQQ 连接到 NoneBot 等框架提供的地址。' },
  { value: 'both', title: '同时启用', note: '正向服务与反向连接一起工作。' },
];

function Probe({ detected, checking, onCheck }: { detected: Detected | null; checking: boolean; onCheck(): void }) {
  const items = [
    { name: 'QQ 客户端', good: Boolean(detected?.qq.valid), text: detected?.qq.version ? 'QQ ' + detected.qq.version : detected?.qq.error || '未检测到' },
    { name: 'C++ 原生引导器', good: Boolean(detected?.native.ready), text: detected?.native.ready ? '已就绪' : detected?.native.error || '未就绪' },
    { name: 'QQ 进程', good: detected ? !detected.qqRunning : false, text: detected ? detected.qqRunning ? '正在运行，请先退出 QQ' : '未运行' : '等待检测' },
  ];
  return <div className="overflow-hidden rounded-lg border">
    <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
      <span className="text-xs font-medium text-muted-foreground">本机环境</span>
      <Button variant="ghost" size="xs" onClick={onCheck} loading={checking}>{!checking && <RefreshCw />}重新检测</Button>
    </div>
    <ul className="divide-y">{items.map(item => <li key={item.name} className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm">{item.name}</span>
      <span className={cn('flex min-w-0 items-center gap-1.5 text-caption', item.good ? 'text-success-text' : 'text-warning-text')}>
        {item.good ? <CircleCheck className="size-4 shrink-0" aria-hidden /> : <TriangleAlert className="size-4 shrink-0" aria-hidden />}<span className="truncate">{item.text}</span>
      </span>
    </li>)}</ul>
  </div>;
}

function CopyRow({ label, value, display }: { label: string; value: string; display?: string }) {
  return <div className="grid gap-1.5">
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-caption">{display ?? value}</code>
      <Button variant="ghost" size="icon-xs" aria-label={'复制' + label} onClick={() => copyText(value)}><Copy /></Button>
    </div>
  </div>;
}

export default function Setup() {
  const client = useQueryClient();
  const resolved = usePreferences(state => state.resolvedTheme), setTheme = usePreferences(state => state.setTheme);
  const [draft, setDraft] = useState<OpenQQConfig | null>(null), [saved, setSaved] = useState<OpenQQConfig | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null), [path, setPath] = useState(''), [initialized, setInitialized] = useState(false);
  const [step, setStep] = useState(0), [highest, setHighest] = useState(0), [mode, setMode] = useState<Mode>('forward');
  const [running, setRunning] = useState(false), [busy, setBusy] = useState(false), [checking, setChecking] = useState(false);
  const [error, setError] = useState(''), [loadError, setLoadError] = useState(''), [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const heading = useRef<HTMLHeadingElement>(null);

  async function load() {
    setLoading(true); setLoadError('');
    try {
      const value = await request<ConfigResponse>('/api/config');
      setDraft(structuredClone(value.config)); setDetected(value.detected ?? null); setPath(value.configPath || 'config/openqq.json');
      setRunning(Boolean(value.running)); setInitialized(value.initialized);
      setMode(value.config.ws.enabled ? value.config.reverseWs.some(item => item.enabled) ? 'both' : 'forward' : 'reverse');
    } catch (failure) { setLoadError((failure as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0 }); }, [step]);

  const update = (change: (value: OpenQQConfig) => void) => setDraft(current => { if (!current) return current; const next = structuredClone(current); change(next); return next; });
  function move(next: number) { setError(''); setErrors({}); setStep(next); setHighest(previous => Math.max(previous, next)); }
  function final(value: OpenQQConfig): OpenQQConfig {
    return { version: 1, qqRoot: value.qqRoot.trim(), webPort: Number(value.webPort), accessToken: value.accessToken,
      ws: { enabled: mode !== 'reverse', host: value.ws.host, port: Number(value.ws.port) },
      reverseWs: value.reverseWs.filter(item => item.url.trim()).map(item => ({ enabled: mode !== 'forward' && item.enabled, url: item.url.trim(), token: item.token })) };
  }
  async function check() {
    if (!draft) return null;
    setChecking(true); setError('');
    try { const value = await request<Detected>('/api/check', { qqRoot: draft.qqRoot.trim() }); setDetected(value); return value; }
    catch (failure) { setError((failure as Error).message); return null; }
    finally { setChecking(false); }
  }
  function chooseMode(value: Mode) {
    setMode(value);
    if (value !== 'forward' && draft && !draft.reverseWs.length) update(next => { next.reverseWs = [{ enabled: true, url: '', token: '' }]; });
  }

  async function advance() {
    if (busy || checking || !draft) return;
    setError(''); setBusy(true);
    try {
      const fieldErrors: Record<string, string> = {};
      if (step === 1) {
        if (!draft.qqRoot.trim()) { setErrors({ qqRoot: '请填写 QQ 安装目录' }); return; }
        const result = await check();
        if (!result?.qq.valid || !result.native.ready) throw new Error('QQ 或原生引导器尚未就绪，请检查检测结果。');
      }
      if (step === 2) {
        if (mode !== 'reverse') { const issue = portError(draft.ws.port); if (issue) fieldErrors['ws.port'] = issue; }
        if (mode !== 'forward') draft.reverseWs.forEach((item, index) => { if (item.url.trim() || item.enabled) { const issue = reverseUrlError(item.url); if (issue) fieldErrors[`reverse.${index}`] = issue; } });
        setErrors(fieldErrors);
        if (Object.keys(fieldErrors).length) return;
        if (mode !== 'forward' && !final(draft).reverseWs.some(item => item.enabled)) throw new Error('请至少添加并启用一个机器人地址。');
      }
      if (step === 3) {
        const token = tokenError(draft.accessToken); if (token) fieldErrors.accessToken = token;
        const web = portError(draft.webPort); if (web) fieldErrors.webPort = web;
        setErrors(fieldErrors);
        if (Object.keys(fieldErrors).length) return;
        if (mode !== 'reverse' && Number(draft.ws.port) === Number(draft.webPort)) throw new Error('WebSocket 与 WebUI 不能使用同一个端口。');
      }
      if (step === 4) {
        const value = await request<{ config: OpenQQConfig; restartRequired: boolean }>('/api/config', final(draft));
        setSaved(value.config); setInitialized(true); setRunning(previous => previous || Boolean(value.restartRequired));
        client.invalidateQueries({ queryKey: ['config'] });
      }
      if (step === 5) {
        if (!running) await request('/api/start', {});
        navigate('/');
        return;
      }
      move(step + 1);
    } catch (failure) {
      const value = failure as Error;
      setError(value.name === 'ApiError' && value.message === '等待响应超时' ? '等待响应超时，请检查终端中的运行状态。' : value.message);
    } finally { setBusy(false); }
  }

  const snapshot = draft ? final(draft) : null;
  const result = saved ?? snapshot;
  const action = step === 0 ? '开始' : step === 4 ? '保存配置' : step === 5 ? running ? '进入控制台' : '启动 OpenQQ' : '下一步';
  const review: [string, string | number][] = snapshot ? [['QQ 安装目录', snapshot.qqRoot], ['连接方式', modes.find(item => item.value === mode)!.title],
    ...(snapshot.ws.enabled ? [['正向地址', forwardAddress(snapshot)] as [string, string]] : []),
    ...snapshot.reverseWs.filter(item => item.enabled).map((item, index) => ['反向地址 ' + (index + 1), item.url] as [string, string]),
    ['Access Token', '已设置 · ' + snapshot.accessToken.length + ' 位'], ['WebUI 端口', snapshot.webPort]] : [];

  return <div className="flex min-h-dvh flex-col">
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
        <Brand />
        <span className="h-4 w-px bg-border" aria-hidden />
        <span className="text-sm text-muted-foreground">接入向导</span>
        <div className="ml-auto flex items-center gap-1">
          {initialized && <Button variant="ghost" size="sm" onClick={() => navigate('/')}><ArrowLeft />控制台</Button>}
          <Button variant="ghost" size="icon-sm" aria-label="切换主题" onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}>{resolved === 'dark' ? <Sun /> : <Moon />}</Button>
        </div>
      </div>
    </header>

    <main className="mx-auto grid w-full max-w-5xl flex-1 items-start gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-12">
      <ol className="flex gap-1.5 overflow-x-auto lg:sticky lg:top-24 lg:grid lg:gap-1" aria-label="设置步骤">
        {steps.map(([title], index) => { const current = index === step, done = index < step || (index <= highest && !current), reachable = index <= highest && !busy; return <li key={title} className="min-w-0 flex-1 lg:flex-none">
          <button type="button" disabled={!reachable} aria-current={current ? 'step' : undefined} onClick={() => reachable && move(index)}
            className={cn('flex w-full items-center gap-3 rounded-lg p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring lg:px-2.5 lg:py-2', reachable && !current && 'hover:bg-muted', current && 'lg:bg-card lg:shadow-sm lg:ring-1 lg:ring-border dark:lg:bg-elevated dark:lg:ring-transparent')}>
            <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border text-2xs font-semibold transition-colors',
              current ? 'border-foreground bg-foreground text-background' : done ? 'border-border-strong bg-muted text-foreground' : 'bg-muted text-muted-foreground')}>
              {done && !current ? <Check className="size-3.5" aria-hidden /> : index + 1}
            </span>
            <span className={cn('hidden truncate text-sm lg:block', current ? 'font-medium text-foreground' : done ? 'text-secondary-foreground' : 'text-muted-foreground')}>{title}</span>
          </button>
        </li>; })}
      </ol>

      <section className="min-w-0 rounded-xl border bg-card shadow-sm">
        {loading ? <div className="grid gap-4 p-6"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-72" /><Skeleton className="h-32" /></div>
          : !draft ? <ErrorState title="无法读取配置" description={loadError} onRetry={load} />
          : <>
            <header className="grid gap-1 border-b px-5 py-5 sm:px-6">
              <span className="text-xs font-medium text-muted-foreground">步骤 {step + 1} / {steps.length}</span>
              <h1 tabIndex={-1} ref={heading} className="text-xl font-semibold tracking-[-0.02em] outline-none">{steps[step][0]}</h1>
              <p className="text-sm text-muted-foreground">{step === 5 && running ? '新配置已保存，将在下次启动 OpenQQ 后生效。' : steps[step][1]}</p>
            </header>

            <div className="grid gap-5 px-5 py-6 sm:px-6">
              {step === 0 && <Probe detected={detected} checking={checking} onCheck={check} />}

              {step === 1 && <>
                <Field label="QQ 安装目录" htmlFor="qq-root" error={errors.qqRoot}
                  description={detected?.qq.valid ? `已识别 QQ ${detected.qq.version ?? ''}` : detected?.qq.error || 'QQ NT 的安装目录'}>
                  <Input id="qq-root" value={draft.qqRoot} spellCheck={false} className="font-mono text-caption" aria-invalid={Boolean(errors.qqRoot)} aria-describedby="qq-root-hint"
                    onChange={event => update(next => { next.qqRoot = event.target.value; })} />
                </Field>
                {Boolean(detected?.qqCandidates.length) && <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">检测到的安装：</span>
                  {detected!.qqCandidates.map(item => <Button key={item.path} variant="outline" size="xs" title={item.path} onClick={() => update(next => { next.qqRoot = item.path; })}>{item.version || item.path}</Button>)}
                </div>}
                <div><Button variant="outline" size="sm" onClick={check} loading={checking}>{!checking && <RefreshCw />}校验路径</Button></div>
              </>}

              {step === 2 && <>
                <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="连接方式">
                  {modes.map(item => <button type="button" role="radio" aria-checked={mode === item.value} key={item.value} onClick={() => chooseMode(item.value)}
                    className={cn('grid gap-1 rounded-lg border p-3.5 text-left outline-none transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-ring',
                      mode === item.value ? 'border-foreground bg-muted/50 ring-1 ring-foreground' : 'hover:border-border-strong hover:bg-muted/40')}>
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className={cn('grid size-4 place-items-center rounded-full border', mode === item.value ? 'border-foreground' : 'border-border-strong')}>{mode === item.value && <span className="size-2 rounded-full bg-foreground" />}</span>
                      {item.title}
                    </span>
                    <span className="text-xs text-muted-foreground">{item.note}</span>
                  </button>)}
                </div>
                {mode !== 'reverse' && <fieldset className="grid gap-4 rounded-lg border p-4">
                  <legend className="px-1 text-xs font-medium text-muted-foreground">正向连接</legend>
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
                    <Field label="监听范围" htmlFor="ws-host"><Select id="ws-host" value={draft.ws.host} onValueChange={value => update(next => { next.ws.host = value as OpenQQConfig['ws']['host']; })}
                      options={[{ value: '127.0.0.1', label: '仅本机 · 127.0.0.1' }, { value: '0.0.0.0', label: '局域网 · 0.0.0.0' }]} /></Field>
                    <Field label="端口" htmlFor="ws-port" error={errors['ws.port']}><Input id="ws-port" inputMode="numeric" className="tabular font-mono" value={String(draft.ws.port)}
                      aria-invalid={Boolean(errors['ws.port'])} aria-describedby="ws-port-hint" onChange={event => update(next => { next.ws.port = Number(event.target.value.replace(/\D/g, '')) || 0; })} /></Field>
                  </div>
                  <p className="text-xs text-muted-foreground">机器人连接地址 <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{forwardAddress(draft)}</code></p>
                </fieldset>}
                {mode !== 'forward' && <fieldset className="grid gap-3 rounded-lg border p-4">
                  <legend className="px-1 text-xs font-medium text-muted-foreground">反向连接</legend>
                  {draft.reverseWs.map((item, index) => <div key={index} className="grid gap-3 rounded-lg border bg-muted/20 p-3.5">
                    <div className="flex items-center gap-3">
                      <Switch checked={item.enabled} onCheckedChange={value => update(next => { next.reverseWs[index].enabled = value; })} aria-label={'启用反向连接 ' + (index + 1)} />
                      <span className="text-sm font-medium">地址 {index + 1}</span>
                      <Button variant="destructive-ghost" size="icon-xs" className="ml-auto" aria-label={'移除反向连接 ' + (index + 1)} onClick={() => update(next => { next.reverseWs.splice(index, 1); })}><Trash2 /></Button>
                    </div>
                    <Field label="机器人地址" htmlFor={`reverse-${index}`} error={errors[`reverse.${index}`]}>
                      <Input id={`reverse-${index}`} value={item.url} placeholder="ws://127.0.0.1:8080/onebot/v11/ws" className="font-mono text-caption" spellCheck={false}
                        aria-invalid={Boolean(errors[`reverse.${index}`])} aria-describedby={`reverse-${index}-hint`} onChange={event => update(next => { next.reverseWs[index].url = event.target.value; })} />
                    </Field>
                    <Field label="机器人端令牌（可选）" htmlFor={`reverse-token-${index}`}>
                      <SecretInput id={`reverse-token-${index}`} value={item.token} onChange={event => update(next => { next.reverseWs[index].token = event.target.value; })} />
                    </Field>
                  </div>)}
                  <Button variant="outline" size="sm" className="border-dashed" disabled={draft.reverseWs.length >= 8} onClick={() => update(next => { next.reverseWs.push({ enabled: true, url: '', token: '' }); })}><Plus />添加地址</Button>
                </fieldset>}
              </>}

              {step === 3 && <>
                <Field label="OneBot Access Token" htmlFor="access-token" error={errors.accessToken}
                  description="机器人端需要填写相同的值；16–256 位非空格 ASCII 字符。"
                  action={<Button variant="link" size="xs" onClick={() => update(next => { next.accessToken = randomHex(32); })}>重新生成</Button>}>
                  <SecretInput id="access-token" value={draft.accessToken} aria-invalid={Boolean(errors.accessToken)} aria-describedby="access-token-hint" onChange={event => update(next => { next.accessToken = event.target.value; })} />
                </Field>
                <Field label="WebUI 端口" htmlFor="web-port" error={errors.webPort} description="仅监听本机，修改后下次启动生效。">
                  <Input id="web-port" inputMode="numeric" className="tabular w-40 font-mono" value={String(draft.webPort)} aria-invalid={Boolean(errors.webPort)} aria-describedby="web-port-hint"
                    onChange={event => update(next => { next.webPort = Number(event.target.value.replace(/\D/g, '')) || 0; })} />
                </Field>
                <p className="text-xs text-muted-foreground">模型服务的 API Key 在 Bot 程序中配置，不在这里填写。</p>
              </>}

              {step === 4 && <DescriptionList items={review.map(([label, value]) => [label, <span className={cn(typeof value === 'string' && /[:\\/]/.test(value) && 'font-mono text-caption')}>{value}</span>])} />}

              {step === 5 && result && <div className="grid gap-4">
                {result.ws.enabled && <div className="grid gap-1.5"><CopyRow label="正向连接地址" value={`ws://127.0.0.1:${result.ws.port}/`} />
                  {result.ws.host === '0.0.0.0' && <p className="text-xs text-muted-foreground">其他设备请把 127.0.0.1 换成这台电脑的局域网 IP。</p>}</div>}
                {result.reverseWs.filter(item => item.enabled).map((item, index) => <CopyRow key={index} label={'反向地址 ' + (index + 1)} value={item.url} />)}
                <CopyRow label="Access Token" value={result.accessToken} display={'•'.repeat(24)} />
                <details className="group rounded-lg border">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden"><Terminal className="size-4 text-muted-foreground" aria-hidden />运行示例 Bot</summary>
                  <div className="grid gap-2 border-t px-4 py-3 text-caption text-secondary-foreground">
                    <p>新开终端，设置 OneBot 令牌并运行示例，然后私聊发送 /ping 测试。</p>
                    <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">{detected?.platform === 'linux' ? "export ONEBOT_TOKEN='你的令牌'\nnpm run bot" : "$env:ONEBOT_TOKEN = '你的令牌'\nnpm run bot"}</pre>
                    <p>调用模型还需设置 BOT_API_URL、BOT_API_KEY、BOT_MODEL 和 BOT_ALLOW_USERS，再私聊发送 /ai 问题。</p>
                  </div>
                </details>
                <p className="text-xs text-muted-foreground">配置文件 <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{path}</code></p>
              </div>}

              {error && <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3.5 py-2.5 text-caption text-destructive-text">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{error}
              </p>}
            </div>

            <footer className="flex items-center justify-between gap-3 border-t px-5 py-4 sm:px-6">
              {step > 0 ? <Button variant="outline" disabled={busy} onClick={() => move(step - 1)}>上一步</Button> : <span className="text-xs text-muted-foreground">配置只保存在这台电脑</span>}
              <Button onClick={advance} loading={busy || checking}>{action}</Button>
            </footer>
          </>}
      </section>
    </main>
  </div>;
}
