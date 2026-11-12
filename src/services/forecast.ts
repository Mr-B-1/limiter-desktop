// Projects when a window runs out from the last hour of readings, held in memory only.
export interface ForecastView { emptyAt: number | null; pastReset: boolean; ratePerHour: number | null; }
const HISTORY_MS = 3600000;
const MIN_SPAN_MS = 5 * 60000;

export class Forecast {
  private readonly history = new Map<string, { at: number; used: number }[]>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  // One reading per key per call; a new window (different resetsAt) starts its history over.
  observe(key: string, usedPercent: number | null, resetsAt: number | null): void {
    if (usedPercent === null || resetsAt === null) { this.history.delete(key); return; }
    const scoped = key + ':' + resetsAt;
    for (const existing of this.history.keys()) if (existing.startsWith(key + ':') && existing !== scoped) this.history.delete(existing);
    const now = this.now();
    const rows = (this.history.get(scoped) || []).filter(row => now - row.at <= HISTORY_MS);
    const last = rows[rows.length - 1];
    if (!last || last.used !== usedPercent || now - last.at >= 60000) rows.push({ at: now, used: usedPercent });
    this.history.set(scoped, rows);
  }
  project(key: string, resetsAt: number | null): ForecastView | null {
    if (resetsAt === null) return null;
    const rows = this.history.get(key + ':' + resetsAt);
    if (!rows || rows.length < 2) return null;
    const first = rows[0]; const last = rows[rows.length - 1];
    if (last.at - first.at < MIN_SPAN_MS) return null;
    const ratePerMs = (last.used - first.used) / (last.at - first.at);
    if (ratePerMs <= 0) return { emptyAt: null, pastReset: true, ratePerHour: Math.round(ratePerMs * 3600000 * 10) / 10 };
    const emptyAt = last.at + (100 - last.used) / ratePerMs;
    return { emptyAt: Math.round(emptyAt), pastReset: emptyAt >= resetsAt * 1000, ratePerHour: Math.round(ratePerMs * 3600000 * 10) / 10 };
  }
}
