// One toast per window when remaining capacity first drops below 20%, and one more below 5%.
export const THRESHOLDS = [20, 5] as const;
export interface AlertRow { key: string; label: string; left: number | null; resetsAt: number | null; estimate: boolean; }
export interface Toast { title: string; body: string; }

export class AlertTracker {
  private readonly fired = new Set<string>();
  evaluate(rows: readonly AlertRow[], now = Date.now()): Toast[] {
    const toasts: Toast[] = [];
    const live = new Set<string>();
    for (const row of rows) {
      if (row.left === null || row.resetsAt === null || row.resetsAt * 1000 <= now) continue;
      for (const threshold of THRESHOLDS) {
        // The window's reset time keys each alert, so a new window re-arms it and a restart never repeats a passed one within the window.
        const id = row.key + ':' + row.resetsAt + ':' + threshold;
        live.add(id);
        if (row.left > threshold || this.fired.has(id)) continue;
        this.fired.add(id);
        const shown = (row.estimate ? '≈' : '') + Math.round(row.left * 10) / 10 + '% left';
        toasts.push({ title: row.label + ': ' + shown, body: (threshold === 5 ? 'Almost out. ' : 'Running low. ') + 'Resets ' + resetText(row.resetsAt, now) + '.' });
      }
    }
    for (const id of this.fired) if (!live.has(id)) this.fired.delete(id);
    return toasts;
  }
}
function resetText(resetsAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((resetsAt * 1000 - now) / 60000));
  if (minutes < 60) return 'in ' + minutes + 'm';
  if (minutes < 1440) return 'in ' + Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm';
  return 'in ' + Math.floor(minutes / 1440) + 'd ' + Math.floor(minutes % 1440 / 60) + 'h';
}
