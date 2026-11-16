import { useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Database, FolderOpen, LogOut, Monitor, Moon, Palette, RefreshCw, ShieldCheck, SlidersHorizontal, Sun, WandSparkles } from 'lucide-react';
import { useAuth, request } from '../lib/api';
import { useConfigDraft } from '../lib/config-draft';
import { usePreferences, type ThemeChoice } from '../lib/preferences';
import { navigate } from '../lib/router';
import { cn } from '../lib/utils';
import type { Detected } from '../lib/types';
import { JsonView } from '../components/json-view';
import { DescriptionList, ErrorState, Page, PageHeader } from '../components/page';
import { SaveBar } from '../components/save-bar';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Field, Input, Switch } from '../components/ui/form';
import { Skeleton } from '../components/ui/misc';
import { Segmented } from '../components/ui/tabs';
import { toast } from '../components/ui/toast';

function Section({ icon: Icon, title, description, children, action }: { icon: typeof Palette; title: string; description: string; children: ReactNode; action?: ReactNode }) {
  return <Card>
    <CardHeader>
      <div className="grid gap-0.5"><CardTitle><Icon className="size-4 text-muted-foreground" aria-hidden />{title}</CardTitle><CardDescription>{description}</CardDescription></div>
      {action}
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>;
}

function Row({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
    <div className="grid min-w-0 gap-0.5"><span className="text-sm font-medium">{label}</span>{description && <span className="text-caption text-muted-foreground">{description}</span>}</div>
    {children}
  </div>;
}

function Check({ good, label, detail }: { good: boolean; label: string; detail: string }) {
  return <div className="flex items-start gap-2.5">
    {good ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
    <span className="grid min-w-0"><span className="text-sm">{label}</span><span className="break-words text-caption text-muted-foreground">{detail}</span></span>
  </div>;
}

export default function Settings() {
  const theme = usePreferences(state => state.theme), setTheme = usePreferences(state => state.setTheme);
  const compact = usePreferences(state => state.compact), setCompact = usePreferences(state => state.setCompact);
  const config = useConfigDraft();
  const [detected, setDetected] = useState<Detected | null>(null), [checking, setChecking] = useState(false);
  const environment = detected ?? config.query.data?.detected ?? null;
  const { draft, issues } = config;

  async function check() {
    if (!draft) return;
    setChecking(true);
    try { setDetected(await request<Detected>('/api/check', { qqRoot: draft.qqRoot.trim() })); }
    catch (error) { toast.error('检测失败', (error as Error).message); }
    finally { setChecking(false); }
  }
  async function save() {
    try { await config.save(); toast.success('设置已保存', config.running ? '重启 OpenQQ 后生效。' : undefined); }
    catch (error) { toast.error('保存失败', (error as Error).message); }
  }
  const masked = draft && { ...draft, accessToken: '••••••••', reverseWs: draft.reverseWs.map(item => ({ ...item, token: item.token ? '••••••••' : '' })) };

  return <Page>
    <PageHeader title="设置" description="界面偏好保存在当前浏览器；客户端与端口设置写入本机配置文件。" />

    <Section icon={Palette} title="外观" description="主题与侧边栏布局">
      <div className="divide-y">
        <Row label="主题" description="跟随系统时会随操作系统的深浅色自动切换">
          <Segmented aria-label="主题" value={theme} onValueChange={value => setTheme(value as ThemeChoice)} size="default"
            options={[{ value: 'light', label: <><Sun className="size-3.5" />浅色</> }, { value: 'dark', label: <><Moon className="size-3.5" />深色</> }, { value: 'system', label: <><Monitor className="size-3.5" />系统</> }]} />
        </Row>
        <Row label="紧凑侧边栏" description="只显示图标，悬停查看名称"><Switch checked={compact} onCheckedChange={setCompact} aria-label="紧凑侧边栏" /></Row>
      </div>
    </Section>

    {config.query.isError ? <Card><ErrorState description={(config.query.error as Error).message} onRetry={() => config.query.refetch()} /></Card>
      : !draft ? <Skeleton className="h-64 rounded-xl" /> : <>
        <Section icon={FolderOpen} title="QQ 客户端" description="OpenQQ 以原生方式启动并挂接的 QQ NT"
          action={<Button variant="outline" size="sm" onClick={check} loading={checking}>{!checking && <RefreshCw />}检测</Button>}>
          <div className="grid gap-4">
            <Field label="安装目录" htmlFor="qq-root" error={issues.qqRoot} description={environment?.platform === 'linux' ? 'QQ NT 的安装目录，例如 /opt/QQ' : 'QQ NT 的安装目录，例如 C:\\Program Files\\Tencent\\QQNT'}>
              <Input id="qq-root" value={draft.qqRoot} spellCheck={false} className="font-mono text-caption" aria-invalid={Boolean(issues.qqRoot)} aria-describedby="qq-root-hint"
                onChange={event => config.update(next => { next.qqRoot = event.target.value; })} />
            </Field>
            {environment?.qqCandidates && environment.qqCandidates.length > 1 && <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">检测到：</span>
              {environment.qqCandidates.map(item => <Button key={item.path} variant="outline" size="xs" title={item.path} onClick={() => config.update(next => { next.qqRoot = item.path; })}>{item.version || item.path}</Button>)}
            </div>}
            {environment && <div className="grid gap-3 rounded-lg border bg-muted/30 p-3.5 sm:grid-cols-3">
              <Check good={environment.qq.valid} label="QQ 客户端" detail={environment.qq.valid ? 'QQ ' + environment.qq.version + (environment.qq.targetMatch ? '' : '（未完整验证）') : environment.qq.error ?? '未检测到'} />
              <Check good={environment.native.ready} label="C++ 原生引导器" detail={environment.native.ready ? '已就绪' : environment.native.error ?? '未就绪'} />
              <Check good={!environment.qqRunning} label="QQ 进程" detail={environment.qqRunning ? '正在运行，启动挂接前请先退出' : '未运行'} />
            </div>}
          </div>
        </Section>

        <Section icon={ShieldCheck} title="WebUI 与安全" description="控制台只监听本机，并要求每次启动随机生成的访问密钥">
          <div className="divide-y">
            <div className="pb-4"><Field label="WebUI 端口" htmlFor="web-port" error={issues.webPort} description="仅监听 127.0.0.1，修改后下次启动生效。">
              <Input id="web-port" inputMode="numeric" className="tabular w-40 font-mono" value={String(draft.webPort)} aria-invalid={Boolean(issues.webPort)} aria-describedby="web-port-hint"
                onChange={event => config.update(next => { next.webPort = Number(event.target.value.replace(/\D/g, '')) || 0; })} />
            </Field></div>
            <Row label="访问密钥" description="只保存在当前标签页的会话存储中，关闭标签页即失效">
              <Button variant="outline" size="sm" onClick={() => useAuth.getState().setToken('')}><LogOut />退出控制台</Button>
            </Row>
            <Row label="OneBot 鉴权" description="Access Token 与正向、反向连接在「连接」页面管理">
              <Button variant="outline" size="sm" onClick={() => navigate('/connections')}>前往连接</Button>
            </Row>
          </div>
        </Section>

        <Section icon={Database} title="数据与保留" description="OpenQQ 不持久化消息内容">
          <DescriptionList items={[
            ['事件与日志', '服务端内存中保留最近 200 条（不超过 2 MiB），重启后清空'],
            ['会话消息', '由当前标签页根据实时事件整理，关闭后清空'],
            ['吞吐指标', '服务端内存中按分钟统计最近 60 分钟'],
            ['QQ 原始日志', <span className="font-mono text-caption">.runtime/qq.log</span>],
            ['配置文件', <span className="break-all font-mono text-caption">{config.query.data?.configPath ?? 'config/openqq.json'}</span>],
          ]} />
        </Section>

        <Section icon={SlidersHorizontal} title="高级" description="当前编辑中的配置（令牌已隐藏）"
          action={<Button variant="outline" size="sm" onClick={() => navigate('/setup')}><WandSparkles />接入向导</Button>}>
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone={config.query.data?.initialized ? 'success' : 'warning'}>{config.query.data?.initialized ? '已保存配置' : '尚未保存配置'}</Badge>
              <Badge tone={config.running ? 'primary' : 'neutral'}>{config.running ? 'OpenQQ 运行中' : 'OpenQQ 未运行'}</Badge>
            </div>
            <JsonView value={masked} copyLabel="复制（令牌已隐藏）" className={cn('max-w-full')} />
          </div>
        </Section>
      </>}

    <SaveBar dirty={config.dirty} valid={config.valid} saving={config.saving} running={config.running} onSave={save} onReset={config.reset} />
  </Page>;
}
