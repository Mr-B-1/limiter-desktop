export type Status = 'loading' | 'ready' | 'signed-out' | 'offline' | 'throttled' | 'timeout' | 'unavailable' | 'compatibility';
export type Theme = 'system' | 'dark' | 'light';
export interface QuotaWindow {
  key: string;
  bucketId: string;
  bucketName: string;
  slot: 'primary' | 'secondary';
  durationMins: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
  restricted: boolean;
}
export interface QuotaSnapshot {
  schemaVersion: 1;
  provider: 'codex';
  generation: number;
  windows: QuotaWindow[];
  selectedKey: string | null;
  selection: 'single' | 'ambiguous' | 'absent';
  fetchedAt: number;
  plan: string;
  scopeConfirmed: boolean;
}
export interface DisplayState {
  status: Status;
  snapshot: QuotaSnapshot | null;
  ageMs: number | null;
  stale: boolean;
  refreshing: boolean;
  cooldownMs: number;
  pinned: boolean;
  theme: Theme;
  settingsNotice: string | null;
  desktopAttached: boolean;
  claude: import('../providers/claude-local.js').ClaudeView;
  grok: import('../providers/grok.js').GrokState;
  storage: import('./storage.js').StorageState;
  forecast: Record<'codex' | 'claude-week' | 'claude-5h' | 'grok', import('../services/forecast.js').ForecastView | null>;
  // Which projects used each provider's current window, from the local logs (plans/2026-10-20-token-counter-by-project-v1.md).
  projects: Record<'claude' | 'codex', import('./projects.js').ProjectsView>;
  // The zone the main process resolved for this PC, so the window formats times in the same zone (see displayTimeZone).
  timeZone?: string;
  // The per-user setup shown in Settings (0.7.0).
  config: {
    projectsRoot: string | null;
    grokcliRoot: string | null;
    localDiskLabel: string | null;
    pcName: string;
    remoteDisk: { host: string; label: string } | null;
    startWithWindows: boolean;
    startupShortcut: boolean;
    firstRun: boolean;
  };
}
// Raw text as typed from the Claude app usage card; main validates it.
export interface ClaudeReadingInput { weeklyPercent: string; weeklyResetsIn: string; fiveHourPercent: string; fiveHourResetsIn: string; }
export interface SettingsChange {
  projectsRoot?: null;
  grokcliRoot?: null;
  localDiskLabel?: string | null;
  remoteDisk?: { host: string; label: string } | null;
  startWithWindows?: boolean;
}
export interface WidgetBridge {
  state(): Promise<DisplayState>;
  refresh(): Promise<void>;
  theme(value: Theme): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<void>;
  resize(request: import('../services/resize.js').ResizeRequest): Promise<void>;
  chooseSource(): Promise<void>;
  chooseFolder(kind: 'projects' | 'grokcli'): Promise<void>;
  updateSettings(change: SettingsChange): Promise<void>;
  firstRunSeen(): Promise<void>;
  calibrateClaude(reading: ClaudeReadingInput): Promise<void>;
  subscribe(listener: (state: DisplayState) => void): () => void;
}
declare global { interface Window { limiter: WidgetBridge; } }

export function windowLabel(minutes: number | null): string {
  if (minutes === null) return 'Unclassified limit';
  if (minutes === 10080) return 'Weekly';
  if (minutes % 1440 === 0) return (minutes / 1440) + '-day limit';
  if (minutes % 60 === 0) return (minutes / 60) + '-hour limit';
  return minutes + '-minute limit';
}
// Times show in the PC's own time zone. A PC on British Columbia time keeps the PST label its owner uses for that clock.
export function zoneLabel(date: Date, timeZone?: string): string {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = new Intl.DateTimeFormat('en-CA', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value.replace('GMT', 'UTC') || 'UTC';
  const short = zone === 'America/Vancouver' ? 'PST' : new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(date).find(part => part.type === 'timeZoneName')?.value || '';
  return (short && !short.startsWith('GMT') ? short + ' ' : '') + '(' + offset + ')';
}
export function resetLabel(epochSeconds: number | null, timeZone?: string): string {
  if (epochSeconds === null) return 'Reset unavailable';
  const date = new Date(epochSeconds * 1000);
  return new Intl.DateTimeFormat('en-CA', { ...(timeZone ? { timeZone } : {}), year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(date) + ' ' + zoneLabel(date, timeZone);
}
export function localStamp(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { ...(timeZone ? { timeZone } : {}), dateStyle: 'short', timeStyle: 'medium' }).format(date) + ' ' + zoneLabel(date, timeZone);
}
export function ageLabel(ageMs: number | null): string {
  if (ageMs === null) return 'Awaiting first read';
  if (ageMs < 60000) return 'Read just now';
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 60) return 'Read ' + minutes + 'm ago';
  return 'Read ' + Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm ago';
}
export function countdown(epoch: number | null, now = Date.now()): string {
  if (epoch === null) return 'Reset unavailable';
  const delta = epoch * 1000 - now;
  if (delta <= 0) return 'Reset passed, awaiting data';
  const minutes = Math.ceil(delta / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  if (days > 0) return 'Resets in ' + days + 'd ' + hours + 'h';
  if (hours > 0) return 'Resets in ' + hours + 'h ' + minutes % 60 + 'm';
  return 'Resets in ' + minutes + 'm';
}
