import type { QuotaSnapshot, Status } from '../shared/usage.js';
import { SourceError } from '../providers/protocol.js';

export interface Clock {
  now(): number;
  wall(): number;
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}
const realClock: Clock = {
  now: () => performance.now(), wall: () => Date.now(),
  set: (callback, delay) => setTimeout(callback, delay),
  clear: timer => clearTimeout(timer as NodeJS.Timeout)
};
export class Coordinator {
  snapshot: QuotaSnapshot | null = null;
  status: Status = 'loading';
  refreshing = false;
  private timer: unknown;
  private lastSuccess: number | null = null;
  private nextAllowed = 0;
  private failures = 0;
  private hidden = false;
  private stopped = false;
  private suspended = false;
  private paused = false;
  private pendingHint = false;
  private resetAttempts = new Set<string>();
  private active: Promise<void> | null = null;
  private pendingFault: unknown = null;
  constructor(private read: () => Promise<QuotaSnapshot>, private update: () => void, private clock: Clock = realClock, private jitter = () => Math.random() * 10000) {}
  get ageMs(): number | null { return this.lastSuccess === null ? null : Math.max(0, this.clock.now() - this.lastSuccess); }
  get stale(): boolean { return this.ageMs !== null && this.ageMs >= (this.hidden ? 30 : 10) * 60000; }
  get cooldownMs(): number { return Math.max(0, this.nextAllowed - this.clock.now()); }
  get interval(): number { return (this.hidden ? 15 : 5) * 60000; }
  invalidate(): void {
    this.snapshot = null;
    this.lastSuccess = null;
    this.resetAttempts.clear();
    this.status = 'loading';
    this.update();
  }
  trigger(reason: 'start' | 'manual' | 'hint' | 'resume' | 'timer' | 'reset' = 'manual'): Promise<void> {
    if (this.stopped || this.suspended) return Promise.resolve();
    if (this.paused && !['manual', 'resume', 'hint'].includes(reason)) return Promise.resolve();
    if (reason === 'manual' || reason === 'resume' || reason === 'hint') this.paused = false;
    if (this.active) {
      if (reason === 'hint' || reason === 'resume') this.pendingHint = true;
      return this.active;
    }
    if (this.cooldownMs > 0) { this.schedule(this.cooldownMs); return Promise.resolve(); }
    this.clock.clear(this.timer);
    this.refreshing = true;
    this.update();
    this.active = (async () => {
      try {
        const snapshot = await this.read();
        if (this.stopped) return;
        if (this.pendingFault) { this.applyFailure(this.pendingFault); this.pendingFault = null; return; }
        this.snapshot = snapshot;
        this.lastSuccess = this.clock.now();
        this.status = snapshot.windows.length ? 'ready' : 'unavailable';
        this.failures = 0;
        this.nextAllowed = this.clock.now() + 10000;
      } catch (error) {
        if (this.stopped) return;
        this.applyFailure(this.pendingFault || error);
        this.pendingFault = null;
      } finally {
        this.refreshing = false;
        this.active = null;
        if (!this.stopped && !this.paused && !this.suspended) {
          const delay = this.pendingHint ? Math.max(1000, this.cooldownMs) : this.failures ? this.cooldownMs : this.interval + this.jitter();
          this.pendingHint = false;
          this.schedule(delay);
        }
        this.update();
      }
    })();
    return this.active;
  }
  reportFailure(error: unknown): void {
    if (this.stopped) return;
    if (this.refreshing) { this.pendingFault = error; return; }
    this.applyFailure(error);
    if (!this.paused) this.schedule(this.cooldownMs);
    this.update();
  }
  private applyFailure(error: unknown): void {
    this.clock.clear(this.timer);
    const kind = error instanceof SourceError ? error.kind : 'unavailable';
    this.status = kind === 'changed' || kind === 'stopped' ? 'loading' : kind;
    if (['signed-out', 'compatibility', 'changed'].includes(kind)) {
      this.snapshot = null;
      this.lastSuccess = null;
    }
    this.failures++;
    this.nextAllowed = this.clock.now() + Math.min(900000, 30000 * 2 ** Math.min(this.failures - 1, 5));
    if (kind === 'changed') this.nextAllowed = this.clock.now() + 1000;
    this.paused = kind === 'signed-out' || kind === 'compatibility';
  }
  private schedule(delay: number): void {
    if (this.stopped || this.suspended || this.paused) return;
    this.clock.clear(this.timer);
    this.timer = this.clock.set(() => { void this.trigger('timer'); }, Math.max(1, delay));
  }
  visibility(hidden: boolean): void {
    const restored = this.hidden && !hidden;
    this.hidden = hidden;
    if (!this.active) this.schedule(Math.max(this.cooldownMs, Math.max(0, this.interval - (this.ageMs || 0))));
    if (restored && (this.ageMs === null || this.ageMs >= 300000)) void this.trigger('resume');
    this.update();
  }
  checkResets(): void {
    for (const window of this.snapshot?.windows || []) {
      if (window.resetsAt === null || window.resetsAt * 1000 > this.clock.wall()) continue;
      const key = window.key + ':' + window.resetsAt;
      if (!this.resetAttempts.has(key)) { this.resetAttempts.add(key); void this.trigger('reset'); break; }
    }
  }
  suspend(): void { this.suspended = true; this.clock.clear(this.timer); }
  resume(): void { this.suspended = false; void this.trigger('resume'); }
  async stop(): Promise<void> {
    this.stopped = true;
    this.clock.clear(this.timer);
    if (this.active) await this.active;
  }
}
