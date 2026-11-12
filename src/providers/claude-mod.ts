import { promises as fs, watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record } from './protocol.js';
import type { ClaudeSample, ClaudeState, ClaudeWindow } from './claude.js';

// The limiter-usage mod (mods/limiter-usage) writes Claude Code's own plan windows here on every turn.
export const MOD_FILE_NAME = 'claude-usage.json';
const MAX_FILE_BYTES = 16 * 1024;
const MAX_WINDOWS = 8;
export const FRESH_MS = 15 * 60000;
const SAFETY_POLL_MS = 60000;
const WATCH_DEBOUNCE_MS = 250;

export interface ModSnapshot { host: string; observedAt: number; sample: ClaudeSample; }
export interface ModState extends ClaudeState { host: string | null; }

export function defaultModFile(home = os.homedir()): string {
  return path.join(home, '.local', 'share', 'Limiter', MOD_FILE_NAME);
}
function window(value: unknown): ClaudeWindow | null {
  if (!record(value) || typeof value.percentUsed !== 'number' || !Number.isFinite(value.percentUsed) || value.percentUsed < 0 || value.percentUsed > 100) return null;
  if (value.resetsAt === undefined) return null;
  const resetMs = typeof value.resetsAt === 'string' ? Date.parse(value.resetsAt) : NaN;
  if (!Number.isFinite(resetMs)) return null;
  return { usedPercent: Math.round(value.percentUsed * 10) / 10, resetsAt: Math.floor(resetMs / 1000) };
}
// Accepts only the mod's own shape; a window without a valid reset time is dropped rather than guessed.
export function parseModSnapshot(value: unknown, now = Date.now()): ModSnapshot | null {
  if (!record(value) || value.schemaVersion !== 1 || value.source !== 'claude-code-mod') return null;
  if (typeof value.host !== 'string' || value.host.length === 0 || value.host.length > 64) return null;
  if (typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt) || value.observedAt > now + 5 * 60000 || value.observedAt < now - 30 * 86400000) return null;
  if (!Array.isArray(value.rateLimits) || value.rateLimits.length > MAX_WINDOWS) return null;
  let fiveHour: ClaudeWindow | null = null;
  let sevenDay: ClaudeWindow | null = null;
  for (const item of value.rateLimits) {
    if (!record(item)) return null;
    if (item.kind === 'five_hour') fiveHour = window(item);
    else if (item.kind === 'seven_day') sevenDay = window(item);
  }
  if (!fiveHour && !sevenDay) return null;
  return { host: value.host, observedAt: value.observedAt, sample: { schemaVersion: 1, observedAt: value.observedAt, fiveHour, sevenDay } };
}
export async function readModFile(file: string, now = Date.now()): Promise<ModSnapshot | null> {
  let bytes: Buffer;
  try { bytes = await fs.readFile(file); } catch { return null; }
  if (bytes.length > MAX_FILE_BYTES) return null;
  try { return parseModSnapshot(JSON.parse(bytes.toString('utf8')), now); } catch { return null; }
}

// Reads one or more mod files (this PC, and synced copies from other hosts) and keeps the newest reading.
export class ClaudeModReader {
  private snapshot: ModSnapshot | null = null;
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private reading: Promise<void> | null = null;
  private stopped = true;
  readonly counts = { reads: 0, accepted: 0 };
  constructor(private readonly changed: () => void, private readonly files: readonly string[], private readonly now: () => number = () => Date.now()) {}
  start(): void {
    this.stopped = false;
    for (const directory of new Set(this.files.map(file => path.dirname(file)))) {
      try {
        const watcher = watch(directory, { persistent: false }, () => this.schedule());
        watcher.on('error', () => undefined);
        this.watchers.push(watcher);
      } catch { /* A missing directory is covered by the safety poll until the mod creates it. */ }
    }
    this.timer = setInterval(() => { void this.refresh(); }, SAFETY_POLL_MS);
    void this.refresh();
  }
  private schedule(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => { void this.refresh(); }, WATCH_DEBOUNCE_MS);
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading = (async () => {
      const now = this.now();
      let newest: ModSnapshot | null = null;
      for (const file of this.files) {
        this.counts.reads++;
        const snapshot = await readModFile(file, now);
        if (snapshot && (!newest || snapshot.observedAt > newest.observedAt)) newest = snapshot;
      }
      // An older reading never replaces a newer one, whichever host wrote it.
      if (newest && (!this.snapshot || newest.observedAt > this.snapshot.observedAt)) { this.snapshot = newest; this.counts.accepted++; this.changed(); }
    })().finally(() => { this.reading = null; });
    return this.reading;
  }
  state(): ModState {
    if (!this.snapshot) return { status: 'waiting', sample: null, ageMs: null, host: null };
    const now = this.now();
    const ageMs = Math.max(0, now - this.snapshot.observedAt);
    const live = (item: ClaudeWindow | null) => item && item.resetsAt * 1000 > now ? item : null;
    const sample = { ...this.snapshot.sample, fiveHour: live(this.snapshot.sample.fiveHour), sevenDay: live(this.snapshot.sample.sevenDay) };
    return { status: ageMs > FRESH_MS ? 'stale' : sample.fiveHour || sample.sevenDay ? 'ready' : 'waiting', sample, ageMs, host: this.snapshot.host };
  }
  stop(): void {
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.debounce);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = []; this.snapshot = null;
  }
}

// Of the two exact feeds (status-line pipe, mod file), the most recently observed reading wins.
export function newestExact(pipe: ClaudeState, mod: ModState): { state: ClaudeState; source: 'status-line' | 'mod' | null; host: string | null } {
  const pipeAt = pipe.sample?.observedAt ?? -Infinity;
  const modAt = mod.sample?.observedAt ?? -Infinity;
  if (pipeAt === -Infinity && modAt === -Infinity) return { state: pipe.status === 'unavailable' ? pipe : mod, source: null, host: null };
  return modAt >= pipeAt ? { state: mod, source: 'mod', host: mod.host } : { state: pipe, source: 'status-line', host: null };
}
