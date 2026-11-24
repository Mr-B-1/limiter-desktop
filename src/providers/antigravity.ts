import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { record } from './protocol.js';

// Antigravity's own language server reports the plan's per-model quota on a loopback port. Its hub file names the port and a
// per-process request token; that token is only sent back to the same local server and never stored, logged or shown.
// The reply also carries account fields (email, name, picture); parseAntigravity keeps only the plan name, model labels and quota.
export interface AntigravityPool { name: string; models: string[]; remainingPercent: number | null; resetsAt: number | null; }
export interface AntigravitySnapshot { observedAt: number; plan: string | null; pools: AntigravityPool[]; }
export interface AntigravityState {
  status: 'absent' | 'closed' | 'loading' | 'ready' | 'signed-out' | 'timeout' | 'compatibility';
  snapshot: AntigravitySnapshot | null;
  stale: boolean;
  refreshing: boolean;
}
export type AntigravityRead = { ok: true; body: unknown } | { ok: false; status: AntigravityState['status'] };

export const ANTIGRAVITY_DAEMON = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
const METHOD = '/exa.language_server_pb.LanguageServerService/GetUserStatus';
const FAMILY_NAMES: Record<string, string> = { gpt: 'GPT' };

// The family comes from the model id's first segment (gemini-4-neon-high is Gemini), because labels such as "Orchestrator (Neon)" hide it.
function family(modelId: unknown, label: string): string {
  const head = (typeof modelId === 'string' && modelId ? modelId : label).split(/[-_ ]/)[0].toLowerCase();
  return FAMILY_NAMES[head] || head.charAt(0).toUpperCase() + head.slice(1);
}
export function parseAntigravity(body: unknown, now = Date.now()): AntigravitySnapshot {
  if (!record(body) || !record(body.userStatus)) throw new Error('schema');
  const status = body.userStatus;
  const planInfo = record(status.planStatus) && record(status.planStatus.planInfo) ? status.planStatus.planInfo : null;
  const plan = planInfo && typeof planInfo.planName === 'string' && planInfo.planName.length <= 40 ? planInfo.planName : null;
  const configs = record(status.cascadeModelConfigData) ? status.cascadeModelConfigData.clientModelConfigs : undefined;
  if (!Array.isArray(configs) || configs.length > 200) throw new Error('schema');
  // Models that share one remaining fraction and one reset minute draw on one pool, so they show as one row.
  const pools = new Map<string, AntigravityPool & { families: Set<string> }>();
  for (const config of configs) {
    if (!record(config)) throw new Error('schema');
    if (config.quotaInfo === undefined || config.quotaInfo === null) continue;
    if (!record(config.quotaInfo) || typeof config.label !== 'string' || config.label.length < 1 || config.label.length > 80) throw new Error('schema');
    // Keep an omitted remainingFraction as null (unknown) rather than substituting 0 (guardrails rule 6).
    const rawFraction = config.quotaInfo.remainingFraction;
    let remainingPercent: number | null = null;
    if (rawFraction !== undefined && rawFraction !== null) {
      if (typeof rawFraction !== 'number' || !Number.isFinite(rawFraction) || rawFraction < 0 || rawFraction > 1) throw new Error('schema');
      remainingPercent = Math.round(rawFraction * 1000) / 10;
    }
    let resetsAt: number | null = null;
    const reset = config.quotaInfo.resetTime;
    if (typeof reset === 'string' && reset) {
      const parsed = Date.parse(reset);
      if (!Number.isFinite(parsed)) throw new Error('schema');
      resetsAt = Math.floor(parsed / 1000);
    } else if (reset !== undefined && reset !== null) throw new Error('schema');
    // shortcut: two pools that share a percentage (or both omit it) and reset in the same minute merge into one row; split them if Antigravity ever names its pools.
    const key = (remainingPercent === null ? 'missing' : String(remainingPercent)) + '|' + (resetsAt === null ? 'none' : Math.floor(resetsAt / 60));
    const pool = pools.get(key) || { name: '', models: [], remainingPercent, resetsAt, families: new Set<string>() };
    pool.models.push(config.label);
    pool.families.add(family(config.modelId, config.label));
    pools.set(key, pool);
  }
  return { observedAt: now, plan, pools: [...pools.values()].map(({ families, ...pool }) => ({ ...pool, name: [...families].join(', ') })) };
}

async function readCapped(response: Response, limit: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// Tries hub files newest first: a closed server leaves its file behind, and its port refuses the connection.
export async function readAntigravity(daemonDir = ANTIGRAVITY_DAEMON, signal?: AbortSignal): Promise<AntigravityRead> {
  let names: string[];
  try { names = (await readdir(daemonDir)).filter(name => /^hub_\d+\.json$/.test(name)); }
  catch { return { ok: false, status: 'absent' }; }
  const hubs = (await Promise.all(names.map(async name => {
    try { return { file: path.join(daemonDir, name), mtime: (await stat(path.join(daemonDir, name))).mtimeMs }; } catch { return null; }
  }))).filter(hub => hub !== null).sort((a, b) => b.mtime - a.mtime).slice(0, 8);
  let status: AntigravityState['status'] = 'closed';
  for (const hub of hubs) {
    if (signal?.aborted) return { ok: false, status: 'closed' };
    let port: unknown, token: unknown;
    try { ({ httpPort: port, csrfToken: token } = JSON.parse(await readFile(hub.file, 'utf8'))); } catch { continue; }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 1 || token.length > 200) continue;
    try {
      const response = await fetch('http://127.0.0.1:' + port + METHOD, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': token },
        body: JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      });
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return { ok: false, status: 'signed-out' }; }
      if (!response.ok) { await response.body?.cancel(); status = 'compatibility'; continue; }
      const text = await readCapped(response, 4 * 1024 * 1024);
      if (text === null) return { ok: false, status: 'compatibility' };
      try { return { ok: true, body: JSON.parse(text) }; } catch { return { ok: false, status: 'compatibility' }; }
    } catch (error) {
      if (signal?.aborted) return { ok: false, status: 'closed' };
      if (error instanceof Error && error.name === 'TimeoutError') status = 'timeout';
    }
  }
  return { ok: false, status };
}

export class AntigravityProvider {
  private snapshot: AntigravitySnapshot | null = null;
  private status: AntigravityState['status'] = 'loading';
  private pending: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private nextRead = 0;
  private stopped = false;
  private lastReadMono = 0;
  private paused = false;
  private controller: AbortController | null = null;
  constructor(private readonly changed: () => void, private readonly transport: (signal: AbortSignal) => Promise<AntigravityRead> = signal => readAntigravity(ANTIGRAVITY_DAEMON, signal), private readonly now: () => number = () => performance.now()) {}
  start(): void { this.stopped = false; void this.refresh('scheduled'); this.timer = setInterval(() => { void this.refresh('scheduled'); }, 5 * 60000); }
  state(): AntigravityState {
    return { status: this.status, snapshot: this.snapshot, stale: !!this.snapshot && (this.status !== 'ready' || this.now() - this.lastReadMono > 10 * 60000), refreshing: !!this.pending };
  }
  // The local server may ask Google for the status, so scheduled reads pause with the other network reads while the PC is idle.
  pause(): void { this.paused = true; }
  resume(): void { if (this.paused) { this.paused = false; void this.refresh('scheduled'); } }
  refresh(reason: 'scheduled' | 'manual' = 'manual'): Promise<void> {
    if (this.stopped || (reason === 'scheduled' && this.paused)) return Promise.resolve();
    if (this.pending) return this.pending;
    if (reason === 'scheduled' && this.now() < this.nextRead) return Promise.resolve();
    this.pending = this.read().finally(() => { this.pending = null; if (!this.stopped) this.changed(); });
    return this.pending;
  }
  private async read(): Promise<void> {
    this.controller = new AbortController();
    this.nextRead = this.now() + 10000;
    if (!this.snapshot) this.status = 'loading';
    this.changed();
    try {
      const result = await this.transport(this.controller.signal);
      if (this.stopped) return;
      if (!result.ok) {
        this.status = result.status;
        // A closed app, a slow reply or a changed reply keeps the last reading, shown as stale. No install or no sign-in clears it.
        if (result.status === 'absent' || result.status === 'signed-out') this.snapshot = null;
        return;
      }
      this.snapshot = parseAntigravity(result.body);
      this.lastReadMono = this.now();
      this.status = 'ready';
    } catch {
      if (!this.stopped) this.status = 'compatibility';
    }
  }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); this.controller?.abort(); await this.pending; this.snapshot = null; }
}
