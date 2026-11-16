export type Phase = 'setup' | 'detached' | 'starting' | 'hook_installed' | 'session_ready' | 'offline' | 'failed' | 'hook_error';

export type ReverseState = 'waiting' | 'connecting' | 'connected' | 'reconnecting';

export interface NetworkState {
  ws: { enabled: boolean; address: string | null; clients: number };
  reverseWs: { index: number; state: ReverseState | string }[];
}

export interface SessionState {
  phase: Phase | string;
  self_id?: string | number;
  version?: string;
  bootstrap?: string;
  pid?: number;
  services?: string[];
  syncing?: boolean;
  error?: string;
  stage?: string;
  network?: NetworkState;
}

export interface Counts { events: number; actions: number; errors: number }

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, unknown>;

export interface Segment { type: string; data?: Record<string, unknown> }

export interface OneBotEvent {
  post_type?: 'message' | 'notice' | 'request' | string;
  message_type?: 'private' | 'group';
  sub_type?: string;
  notice_type?: string;
  request_type?: string;
  message_id?: number | string;
  user_id?: number;
  group_id?: number;
  target_id?: number;
  time?: number;
  self_id?: number;
  message?: Segment[] | string;
  raw_message?: string;
  comment?: string;
  sender?: { user_id?: number; nickname?: string; card?: string };
  [key: string]: unknown;
}

export interface ActionRequest { action: string; params?: Record<string, unknown>; echo?: unknown }
export interface ActionResponse { status: 'ok' | 'failed' | string; retcode: number; data?: unknown; message?: string; echo?: unknown }

export interface ActionRecord {
  request?: ActionRequest;
  response?: ActionResponse;
  source?: 'webui' | 'onebot' | 'terminal' | string;
  elapsed?: number;
}

export interface Diagnostic { type?: string; stage?: string; error?: string; source?: string; event?: string; [key: string]: unknown }

export type Entry =
  | { id: number; kind: 'event'; time: string; data: OneBotEvent }
  | { id: number; kind: 'action'; time: string; data: ActionRecord }
  | { id: number; kind: 'diagnostic'; time: string; data: Diagnostic };

export interface ReverseConfig { enabled: boolean; url: string; token: string }
export interface OpenQQConfig {
  version: 1;
  qqRoot: string;
  webPort: number;
  accessToken: string;
  ws: { enabled: boolean; host: '127.0.0.1' | '0.0.0.0'; port: number };
  reverseWs: ReverseConfig[];
}

export interface Detected {
  platform: string;
  arch?: string;
  qq: { path: string; valid: boolean; targetMatch: boolean; version: string | null; arch: string | null; error: string | null };
  qqCandidates: { path: string; version?: string; supported?: boolean }[];
  native: { ready: boolean; error: string | null; launcher?: string; dll?: string };
  qqRunning: boolean;
  hasSavedHint: boolean;
}

export interface ConfigResponse { config: OpenQQConfig; initialized: boolean; running: boolean; configPath: string; detected?: Detected }

export interface Metrics {
  startedAt: string;
  uptime: number;
  process: { pid: number; node: string; platform: string; rss: number; heapUsed: number; heapTotal: number; cpu: number };
  latency: { samples: number; average: number | null; p95: number | null; last: number | null };
  timeline: { minute: number; events: number; actions: number; errors: number }[];
}
