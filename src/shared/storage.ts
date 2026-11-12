// The local disk is this PC's system drive; the remote disk is optional and read over SSH through a host alias the user set.
export const diskIds = ['local', 'remote'] as const;
export type DiskId = typeof diskIds[number];
export interface DiskSpace { totalBytes: number; freeBytes: number }
export interface DiskReading extends DiskSpace { observedAt: number }
// 'off' means the remote disk has no host set, so its row is hidden.
export interface DiskState { status: 'waiting' | 'ready' | 'unavailable' | 'stale' | 'off'; reading: DiskReading | null; label: string; volume: string }
export type StorageState = Record<DiskId, DiskState>;
export const emptyStorage = (): StorageState => ({
  local: { status: 'waiting', reading: null, label: 'This PC', volume: 'C:' },
  remote: { status: 'off', reading: null, label: 'Remote', volume: '/' }
});
// An SSH host alias or name: letters, digits, dots, hyphens and underscores, never starting with a hyphen, so it cannot become an ssh option.
export function validHost(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/.test(value);
}
export function validLabel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 24 && !/[\u0000-\u001f<>]/.test(value);
}
// Decimal units match the displayed GB and TB labels. Keep a full disk distinct from a failed read.
export function formatDiskBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' ' + units[unit];
}
