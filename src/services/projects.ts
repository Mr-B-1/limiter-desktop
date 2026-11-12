import { WEEK_MS, weeklyWindow, type ProjectTotal } from '../providers/claude-local.js';
import { TOP_ROWS, type ProjectCoverage, type ProjectsView } from '../shared/projects.js';
import type { QuotaSnapshot } from '../shared/usage.js';

// Windows are milliseconds, [start, end); end is null for a rolling week with no known reset (plan decision D5).
export interface UsageWindow { start: number; end: number | null; }

// Claude's weekly window follows the row's reset (epoch seconds from the exact feed or the calibration), rolled forward once it passes.
export function claudeWindow(now: number, resetsAtSeconds: number | null): UsageWindow {
  return weeklyWindow(now, resetsAtSeconds === null ? null : resetsAtSeconds * 1000);
}
// Codex's window is the selected account limit: its reset time and duration, rolled forward once the reset passes.
export function codexWindow(now: number, snapshot: QuotaSnapshot | null): UsageWindow {
  const selected = snapshot?.windows.find(window => window.key === snapshot.selectedKey);
  if (!selected || selected.resetsAt === null || selected.durationMins === null || selected.durationMins <= 0) return { start: now - WEEK_MS, end: null };
  const length = selected.durationMins * 60000;
  let end = selected.resetsAt * 1000;
  if (end <= now) end += Math.ceil((now - end) / length) * length;
  if (end <= now) end += length;
  return { start: end - length, end };
}
// Top rows by weighted share of the window's total; the two outside rows rank like any project (plan decision D7).
export function rank(totals: readonly ProjectTotal[], window: UsageWindow, coverage: ProjectCoverage | null): ProjectsView {
  let totalUnits = 0;
  let totalTokens = 0;
  for (const total of totals) { totalUnits += total.units; totalTokens += total.tokens; }
  const rows = [...totals].sort((a, b) => b.units - a.units || a.name.localeCompare(b.name)).slice(0, TOP_ROWS)
    .map(total => ({ name: total.name, share: totalUnits > 0 ? Math.round(total.units / totalUnits * 1000) / 10 : 0, units: total.units, tokens: total.tokens }));
  const degraded = !!coverage && (coverage.skipped > 0 || coverage.unreadable > 0 || coverage.malformedLines > 0);
  return { rows, window, coverage, status: degraded ? 'degraded' : 'ok', totalUnits, totalTokens };
}
