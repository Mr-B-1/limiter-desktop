import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { record } from './protocol.js';

export interface ClaudeWindow { usedPercent: number; resetsAt: number; }
export interface ClaudeSample { schemaVersion: 1; observedAt: number; fiveHour: ClaudeWindow | null; sevenDay: ClaudeWindow | null; }
export interface ClaudeState { status: 'waiting' | 'ready' | 'stale' | 'unavailable'; sample: ClaudeSample | null; ageMs: number | null; }
export function claudePipe(home = os.homedir()): string {
  return '\\\\.\\pipe\\limiter-claude-' + createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
}
function quotaWindow(value: unknown): ClaudeWindow | null {
  if (!record(value) || typeof value.used_percentage !== 'number' || !Number.isFinite(value.used_percentage) || value.used_percentage < 0 || value.used_percentage > 100 ||
      typeof value.resets_at !== 'number' || !Number.isInteger(value.resets_at) || value.resets_at < 1 || value.resets_at > 4102444800) return null;
  return { usedPercent: value.used_percentage, resetsAt: value.resets_at };
}
export function statusLineSample(value: unknown, now = Date.now()): ClaudeSample {
  const limits = record(value) && record(value.rate_limits) ? value.rate_limits : {};
  return { schemaVersion: 1, observedAt: now, fiveHour: quotaWindow(limits.five_hour), sevenDay: quotaWindow(limits.seven_day) };
}
export function parseClaudeSample(value: unknown, now = Date.now()): ClaudeSample | null {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt) || value.observedAt > now + 5000 || value.observedAt < now - 60000) return null;
  const from = (item: unknown) => record(item) ? quotaWindow({ used_percentage: item.usedPercent, resets_at: item.resetsAt }) : null;
  return { schemaVersion: 1, observedAt: value.observedAt, fiveHour: from(value.fiveHour), sevenDay: from(value.sevenDay) };
}
export class ClaudeProvider {
  private server: Server | null = null;
  private sample: ClaudeSample | null = null;
  private unavailable = false;
  private receivedMono = 0;
  private lastClock: { wall: number; mono: number } | null = null;
  private clockEpoch = 0;
  private sampleEpoch = 0;
  constructor(private readonly changed: () => void, private readonly pipe = claudePipe(), private readonly clock = () => ({ wall: Date.now(), mono: performance.now() })) {}
  private time(): { wall: number; mono: number } {
    const now = this.clock();
    if (this.lastClock && now.wall - this.lastClock.wall < now.mono - this.lastClock.mono - 1000) this.clockEpoch++;
    this.lastClock = now;
    return now;
  }
  start(): void {
    this.server = createServer(socket => {
      let bytes = 0;
      let input = '';
      socket.setTimeout(1000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2048) { socket.destroy(); return; }
        input += chunk.toString('utf8');
        if (!input.includes('\n')) return;
        try {
          const now = this.time();
          const parsed = parseClaudeSample(JSON.parse(input.trim()), now.wall);
          if (parsed && (!this.sample || this.sampleEpoch !== this.clockEpoch || parsed.observedAt >= this.sample.observedAt)) {
            this.sample = parsed; this.receivedMono = now.mono; this.sampleEpoch = this.clockEpoch; this.changed();
          }
        } catch { /* A malformed local sender cannot change a valid sample. */ }
        socket.end();
      });
    });
    this.server.on('error', () => { this.unavailable = true; this.changed(); });
    this.server.listen({ path: this.pipe, readableAll: false, writableAll: false });
  }
  state(): ClaudeState {
    if (this.unavailable) return { status: 'unavailable', sample: null, ageMs: null };
    if (!this.sample) return { status: 'waiting', sample: null, ageMs: null };
    const { wall: now, mono } = this.time();
    const ageMs = Math.max(0, mono - this.receivedMono);
    const sample = { ...this.sample,
      fiveHour: this.sample.fiveHour && this.sample.fiveHour.resetsAt * 1000 > now ? this.sample.fiveHour : null,
      sevenDay: this.sample.sevenDay && this.sample.sevenDay.resetsAt * 1000 > now ? this.sample.sevenDay : null };
    return { status: this.sampleEpoch !== this.clockEpoch || ageMs > 15 * 60000 ? 'stale' : sample.fiveHour || sample.sevenDay ? 'ready' : 'waiting', sample, ageMs };
  }
  stop(): void { this.server?.close(); this.server = null; this.sample = null; }
}
