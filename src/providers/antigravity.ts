import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { record } from './protocol.js';

// Antigravity's own language server reports the plan's quota on a loopback port. Its hub file names the port and a per-process
// request token; that token is only sent back to the same local server and never stored, logged or shown.
// RetrieveUserQuotaSummary is the call behind Antigravity's own quota page: each model group has a weekly and a 5-hour bucket.
// GetUserStatus (used through 0.8.1) carried only the 5-hour fraction per model, plus account fields that Limiter never needs.
export interface AntigravityBucket { remainingPercent: number | null; resetsAt: number | null; }
export interface AntigravityPool { name: string; models: string[]; weekly: AntigravityBucket | null; fiveHour: AntigravityBucket | null; }
export interface AntigravitySnapshot { observedAt: number; pools: AntigravityPool[]; }
export interface AntigravityState {
  status: 'absent' | 'closed' | 'loading' | 'ready' | 'signed-out' | 'timeout' | 'compatibility';
  snapshot: AntigravitySnapshot | null;
  stale: boolean;
  refreshing: boolean;
}
export type AntigravityRead = { ok: true; body: unknown } | { ok: false; status: AntigravityState['status'] };

export const ANTIGRAVITY_DAEMON = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
const METHOD = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

function bucket(value: Record<string, unknown>): AntigravityBucket {
  // Keep an omitted remainingFraction as null (unknown) rather than substituting 0 (guardrails rule 6).
  const fraction = value.remainingFraction;
  let remainingPercent: number | null = null;
  if (fraction !== undefined && fraction !== null) {
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('schema');
    remainingPercent = Math.round(fraction * 1000) / 10;
  }
  let resetsAt: number | null = null;
  const reset = value.resetTime;
  if (typeof reset === 'string' && reset) {
    const parsed = Date.parse(reset);
    if (!Number.isFinite(parsed)) throw new Error('schema');
    resetsAt = Math.floor(parsed / 1000);
  } else if (reset !== undefined && reset !== null) throw new Error('schema');
  return { remainingPercent, resetsAt };
}
export function parseAntigravity(body: unknown, now = Date.now()): AntigravitySnapshot {
  if (!record(body) || !record(body.response) || !Array.isArray(body.response.groups) || body.response.groups.length > 20) throw new Error('schema');
  const pools = body.response.groups.map((group: unknown): AntigravityPool => {
    if (!record(group) || typeof group.displayName !== 'string' || group.displayName.length < 1 || group.displayName.length > 80 ||
        !Array.isArray(group.buckets) || group.buckets.length > 10) throw new Error('schema');
    // "Claude and GPT models" shows as "Claude, GPT" so the name fits under a ring.
    const name = group.displayName.replace(/\s+models?$/i, '').replace(/\s+and\s+/gi, ', ');
    const listed = typeof group.description === 'string' ? /:\s*(.+)$/.exec(group.description) : null;
    const models = listed ? listed[1].split(',').map(model => model.trim()).filter(model => model && model.length <= 80).slice(0, 50) : [];
    const pool: AntigravityPool = { name, models, weekly: null, fiveHour: null };
    for (const value of group.buckets) {
      if (!record(value)) throw new Error('schema');
      if (value.window === 'weekly') pool.weekly = bucket(value);
      else if (value.window === '5h') pool.fiveHour = bucket(value);
    }
    return pool;
  });
  return { observedAt: now, pools };
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
