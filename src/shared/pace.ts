// Pace compares how much of a window is used with how much of its time has passed.
export const FIVE_HOUR_MS = 5 * 3600000;
export const WEEK_MS = 7 * 86400000;
export const AHEAD_MARGIN = 10;

export interface Pace { elapsedPercent: number; aheadBy: number; label: 'ahead of pace' | 'on pace' | 'behind pace'; }

// resetsAt is epoch seconds; windowMs the window's full length; a window whose reset has passed has no pace.
export function paceOf(usedPercent: number | null, resetsAt: number | null, windowMs: number, now = Date.now()): Pace | null {
  if (usedPercent === null || resetsAt === null) return null;
  const end = resetsAt * 1000;
  if (end <= now) return null;
  const elapsedPercent = Math.min(100, Math.max(0, Math.round((1 - (end - now) / windowMs) * 1000) / 10));
  const aheadBy = Math.round((usedPercent - elapsedPercent) * 10) / 10;
  return { elapsedPercent, aheadBy, label: aheadBy > AHEAD_MARGIN ? 'ahead of pace' : aheadBy < -AHEAD_MARGIN ? 'behind pace' : 'on pace' };
}
