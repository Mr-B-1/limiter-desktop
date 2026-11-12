// A short launch history in the state folder, so a restart can prove whether Windows started Limiter at sign-in:
// a Startup-folder launch is not logged by Windows, and a desktop double-click looks the same from inside the app.
export interface LaunchRecord { at: string; uptimeMinutes: number; kind: 'start' | 'second' | 'boot-error'; detail?: string; }
export const MAX_LAUNCHES = 20;
const KINDS = new Set(['start', 'second', 'boot-error']);

function valid(value: unknown): value is LaunchRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.at === 'string' && record.at.length <= 40 && typeof record.uptimeMinutes === 'number' && Number.isFinite(record.uptimeMinutes) &&
    typeof record.kind === 'string' && KINDS.has(record.kind) && (record.detail === undefined || (typeof record.detail === 'string' && record.detail.length <= 300));
}
// Keeps the newest entries; anything malformed in the old file is dropped rather than trusted.
export function appendLaunch(existing: unknown, entry: LaunchRecord, max = MAX_LAUNCHES): LaunchRecord[] {
  const kept = Array.isArray(existing) ? existing.filter(valid) : [];
  const detail = entry.detail === undefined ? undefined : entry.detail.slice(0, 300);
  return [...kept, { ...entry, ...(detail === undefined ? {} : { detail }) }].slice(-max);
}
export { localStamp } from '../shared/usage.js';
