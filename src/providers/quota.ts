import type { QuotaSnapshot, QuotaWindow } from '../shared/usage.js';
import { SourceError, record } from './protocol.js';

function label(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : fallback;
}
function nullableInteger(value: unknown, maximum: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new SourceError('compatibility');
  return value;
}
export function parseQuota(value: unknown, generation: number, plan: string, scopeConfirmed: boolean, now = Date.now()): QuotaSnapshot {
  if (!record(value)) throw new SourceError('compatibility');
  let buckets: Record<string, unknown>;
  if (value.rateLimitsByLimitId !== undefined && value.rateLimitsByLimitId !== null) {
    if (!record(value.rateLimitsByLimitId)) throw new SourceError('compatibility');
    buckets = value.rateLimitsByLimitId;
  } else if (record(value.rateLimits)) {
    buckets = { [label(value.rateLimits.limitId, 'default')]: value.rateLimits };
  } else if (value.rateLimits === null || value.rateLimits === undefined) buckets = {};
  else throw new SourceError('compatibility');
  if (Object.keys(buckets).length > 100) throw new SourceError('compatibility');
  const windows: QuotaWindow[] = [];
  let conflict = false;
  for (const [identifier, bucket] of Object.entries(buckets)) {
    if (!record(bucket)) throw new SourceError('compatibility');
    const bucketId = label(identifier, 'unknown');
    if (typeof bucket.limitId === 'string' && bucket.limitId !== identifier) conflict = true;
    for (const slot of ['primary', 'secondary'] as const) {
      const raw = bucket[slot];
      if (raw === null || raw === undefined) continue;
      if (!record(raw)) throw new SourceError('compatibility');
      const used = raw.usedPercent;
      if (used !== undefined && used !== null && (typeof used !== 'number' || !Number.isInteger(used) || used < 0 || used > 2147483647)) throw new SourceError('compatibility');
      const usedPercent = typeof used === 'number' ? used : null;
      windows.push({
        key: bucketId + ':' + slot, bucketId, bucketName: label(bucket.limitName, bucketId === 'codex' ? 'Codex' : bucketId),
        slot, durationMins: nullableInteger(raw.windowDurationMins, Number.MAX_SAFE_INTEGER),
        usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
        resetsAt: nullableInteger(raw.resetsAt, 8640000000000),
        restricted: bucket.spendControlReached === true || (bucket.rateLimitReachedType !== null && bucket.rateLimitReachedType !== undefined)
      });
    }
  }
  const weekly = windows.filter(window => window.durationMins === 10080);
  const codexWeekly = weekly.filter(window => window.bucketId === 'codex');
  const selected = conflict ? null : codexWeekly.length === 1 ? codexWeekly[0] : codexWeekly.length === 0 && weekly.length === 1 ? weekly[0] : null;
  return { schemaVersion: 1, provider: 'codex', generation, windows, selectedKey: selected?.key || null,
    selection: selected ? 'single' : weekly.length > 0 ? 'ambiguous' : 'absent', fetchedAt: now,
    plan: label(plan, 'Codex account'), scopeConfirmed };
}
