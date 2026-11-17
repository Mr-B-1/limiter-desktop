import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { record } from './protocol.js';

// The user's signed-in grokcli checkout (Settings, grokcli folder) owns the Grok sign-in and its renewal; Limiter only runs its read-only quota command.
export type GrokPeriod = 'weekly' | 'monthly' | 'daily' | 'unknown';
export interface GrokProduct { name: string; usedPercent: number | null; }
export interface GrokSnapshot {
  observedAt: number;
  source: 'credits' | 'legacy';
  period: GrokPeriod;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: number | null;
  products: GrokProduct[];
}
export interface GrokState {
  status: 'setup' | 'loading' | 'ready' | 'signed-out' | 'offline' | 'unauthorized' | 'throttled' | 'timeout' | 'compatibility';
  snapshot: GrokSnapshot | null;
  stale: boolean;
  refreshing: boolean;
}
export type GrokRead = { ok: true; scope: string; summary: unknown } | { ok: false; status: GrokState['status'] };

function percent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('schema');
  return Math.round(value * 10) / 10;
}
function optionalPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return percent(value);
}
export function parseGrok(summary: unknown, now = Date.now()): GrokSnapshot {
  if (!record(summary) || (summary.source !== 'credits' && summary.source !== 'legacy')) throw new Error('schema');
  const period = summary.period;
  if (period !== 'weekly' && period !== 'monthly' && period !== 'daily' && period !== 'unknown') throw new Error('schema');
  const usedPercent = optionalPercent(summary.usedPercent);
  const remainingPercent = optionalPercent(summary.remainingPercent);
  if ((usedPercent === null) !== (remainingPercent === null)) throw new Error('schema');
  let resetsAt: number | null = null;
  if (typeof summary.resetsAt === 'string' && summary.resetsAt) {
    const parsed = Date.parse(summary.resetsAt);
    if (!Number.isFinite(parsed)) throw new Error('schema');
    resetsAt = Math.floor(parsed / 1000);
  } else if (summary.resetsAt !== null && summary.resetsAt !== undefined) throw new Error('schema');
  if (!Array.isArray(summary.products) || summary.products.length > 8) throw new Error('schema');
  const products = summary.products.map(item => {
    if (!record(item) || typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 40) throw new Error('schema');
    return { name: item.name, usedPercent: optionalPercent(item.usedPercent) };
  });
  return { observedAt: now, source: summary.source, period, usedPercent, remainingPercent, resetsAt, products };
}
// The Store app-execution alias is a reparse point, so check it with lstat rather than stat.
export function findPython(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'python.exe');
    try { lstatSync(candidate); return candidate; } catch { /* Not in this directory. */ }
  }
  return null;
}
// Maps grokcli's documented `quota --output json` summary onto the reader's camel-case shape.
export function fromCli(summary: unknown): unknown {
  if (!record(summary)) throw new Error('schema');
  const period = record(summary.period) ? summary.period.type : undefined;
  const products = Array.isArray(summary.products) ? summary.products.map(item => record(item) ? { name: item.name, usedPercent: item.used_percent ?? null } : item) : summary.products;
  return { source: summary.source, period: typeof period === 'string' ? period : 'unknown', usedPercent: summary.used_percent ?? null,
    // grokcli reports 0% remaining with no used figure when a legacy plan has no credit total; that is unknown, not empty.
    remainingPercent: summary.used_percent === null || summary.used_percent === undefined ? null : summary.remaining_percent ?? null, resetsAt: summary.resets_at ?? null, products };
}
// grokcli exit codes: 1 general error, 3 sign-in or plan denied, 4 quota or rate limit, 5 timeout, 6 network (grokcli/errors.py ExitCode).
// Exit 1 includes xAI server errors left after grokcli's own retries; it is transient, so it retries on the next read instead of
// holding the row until Refresh (one bad read once hid the Grok row for a day). Exit 2, a changed CLI, still holds.
const EXIT_STATUS: Record<number, GrokState['status']> = { 1: 'offline', 4: 'throttled', 5: 'timeout', 6: 'offline' };
// Exit 3 covers both a dead sign-in and a plan without access; grokcli's error JSON says which.
export function reloginRequired(stderr: string): boolean | null {
  const line = stderr.trim().split('\n').pop()?.trim() || '';
  try {
    const parsed: unknown = JSON.parse(line);
    const flag = record(parsed) && record(parsed.error) ? parsed.error.relogin_required : undefined;
    return typeof flag === 'boolean' ? flag : null;
  } catch { return null; }
}
export async function readGrokQuota(root: string, python = findPython()): Promise<GrokRead> {
  if (!python) return { ok: false, status: 'setup' };
  try { await access(path.join(root, 'grokcli', 'cli.py')); } catch { return { ok: false, status: 'setup' }; }
  const home = os.homedir();
  return await new Promise(resolve => {
    // -E and -s keep the user's Python environment and site packages out, -B writes no bytecode into the checkout.
    const child = spawn(python, ['-B', '-E', '-s', '-m', 'grokcli', 'quota', '--output', 'json'], {
      cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { SystemRoot: process.env.SystemRoot, USERPROFILE: home, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH, LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONIOENCODING: 'utf-8', GROKCLI_HOME: path.join(home, '.config', 'grokcli') },
    });
    let output = '';
    let overflow = false;
    let timedOut = false;
    let errors = '';
    // Only grokcli's relogin_required flag is read from stderr; the rest is dropped in memory.
    child.stderr.on('data', chunk => { if (errors.length < 16384) errors += chunk.toString('utf8'); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
    child.stdout.on('data', chunk => { output += chunk.toString('utf8'); if (output.length > 65536) { overflow = true; child.kill(); } });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, status: 'setup' }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) { resolve({ ok: false, status: 'timeout' }); return; }
      if (overflow) { resolve({ ok: false, status: 'compatibility' }); return; }
      if (code === 3) { resolve({ ok: false, status: reloginRequired(errors) === false ? 'unauthorized' : 'signed-out' }); return; }
      if (code !== 0) { resolve({ ok: false, status: EXIT_STATUS[code ?? -1] || 'compatibility' }); return; }
      try { resolve({ ok: true, scope: '', summary: fromCli(JSON.parse(output)) }); }
      catch { resolve({ ok: false, status: 'compatibility' }); }
    });
  });
}

export class GrokProvider {
  private snapshot: GrokSnapshot | null = null;
  private status: GrokState['status'] = 'loading';
  private pending: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private nextRead = 0;
  private stopped = false;
  private scope: string | null = null;
  private lastReadMono = 0;
  // A dead sign-in, a missing setup or a changed source does not fix itself; scheduled reads stop until B presses Refresh.
  private held = false;
  private paused = false;
  // Main passes a transport bound to the user's grokcli folder; without one the row stays in setup.
  constructor(private readonly changed: () => void, private readonly transport: () => Promise<GrokRead> = async () => ({ ok: false, status: 'setup' }), private readonly now: () => number = () => performance.now()) {}
  start(): void { this.stopped = false; void this.refresh('scheduled'); this.timer = setInterval(() => { void this.refresh('scheduled'); }, 15 * 60000); }
  state(): GrokState {
    return { status: this.status, snapshot: this.snapshot, stale: !!this.snapshot && (this.status !== 'ready' || this.now() - this.lastReadMono > 20 * 60000), refreshing: !!this.pending };
  }
  pause(): void { this.paused = true; }
  resume(): void { if (this.paused) { this.paused = false; void this.refresh('scheduled'); } }
  refresh(reason: 'scheduled' | 'manual' = 'manual'): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (reason === 'scheduled' && (this.held || this.paused)) return Promise.resolve();
    if (reason === 'manual') this.held = false;
    if (this.pending) return this.pending;
    if (this.now() < this.nextRead) return Promise.resolve();
    this.pending = this.read().finally(() => { this.pending = null; if (!this.stopped) this.changed(); });
    return this.pending;
  }
  private async read(): Promise<void> {
    const scope = this.scope;
    this.nextRead = this.now() + 10000;
    this.status = this.snapshot ? 'ready' : 'loading';
    this.changed();
    try {
      const result = await this.transport();
      if (this.stopped) return;
      if (!result.ok) {
        this.status = result.status;
        if (result.status === 'signed-out' || result.status === 'unauthorized' || result.status === 'setup' || result.status === 'compatibility') { this.snapshot = null; this.scope = null; this.held = true; }
        if (result.status === 'throttled') this.nextRead = this.now() + 15 * 60000;
        return;
      }
      const parsed = parseGrok(result.summary);
      if (this.stopped || (scope && result.scope !== scope)) return;
      this.scope = result.scope;
      this.snapshot = parsed;
      this.lastReadMono = this.now();
      this.status = 'ready';
    } catch {
      if (!this.stopped) { this.status = 'compatibility'; this.snapshot = null; this.scope = null; this.held = true; }
    }
  }
  async stop(): Promise<void> { this.stopped = true; this.scope = null; clearInterval(this.timer); await this.pending; this.snapshot = null; }
}
