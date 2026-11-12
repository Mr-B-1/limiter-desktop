import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { Theme } from '../shared/usage.js';
import { record } from '../providers/protocol.js';
import { parseCalibration, type ClaudeCalibration } from '../providers/claude-local.js';
import { validHost, validLabel } from '../shared/storage.js';

export interface Bounds { x: number; y: number; width: number; height: number; }
export interface RemoteDisk { host: string; label: string; }
// Version 3 adds the per-user setup (0.7.0). Every new field is optional, so a version 2 file reads with them unset.
export interface Preferences {
  schemaVersion: 3;
  pinned: boolean;
  theme: Theme;
  bounds: Bounds | null;
  codexPath: string | null;
  lastCodexPath: string | null;
  claudeCalibration: ClaudeCalibration | null;
  // Folder whose first-level folders are the projects; null groups usage by each session's folder name.
  projectsRoot: string | null;
  // grokcli checkout that owns the Grok sign-in; null hides the Grok row.
  grokcliRoot: string | null;
  // Name shown on the local disk row; null uses the PC's name.
  localDiskLabel: string | null;
  // Optional second disk read over SSH; null hides that row.
  remoteDisk: RemoteDisk | null;
}
export const COMPACT_SIZE = { width: 270, height: 346 };
// A fresh widget fits five 84px rows plus the header, footer and border. Saved sizes keep the original minimum.
const FIRST_LAUNCH_SIZE = { width: COMPACT_SIZE.width, height: 480 };
export const defaults = (): Preferences => ({ schemaVersion: 3, pinned: false, theme: 'system', bounds: null, codexPath: null, lastCodexPath: null, claudeCalibration: null,
  projectsRoot: null, grokcliRoot: null, localDiskLabel: null, remoteDisk: null });
function folder(item: unknown): string | null {
  if (item === null || item === undefined) return null;
  if (typeof item !== 'string' || item.length > 260 || !path.isAbsolute(item) || /[\u0000-\u001f]/.test(item)) throw new Error('Invalid folder preference');
  return item;
}
export function parsePreferences(value: unknown): Preferences {
  if (!record(value) || ![1, 2, 3].includes(Number(value.schemaVersion)) || typeof value.pinned !== 'boolean' ||
      !['system', 'light', 'dark'].includes(String(value.theme))) throw new Error('Preferences version or type unsupported');
  const nativePath = (item: unknown): string | null => {
    if (item === null || item === undefined) return null;
    if (typeof item !== 'string' || !path.isAbsolute(item) || path.basename(item).toLowerCase() !== 'codex.exe') throw new Error('Invalid executable preference');
    return item;
  };
  let bounds: Bounds | null = null;
  if (value.bounds !== null && value.bounds !== undefined) {
    const raw = value.bounds;
    if (!record(raw) || !['x', 'y', 'width', 'height'].every(key => typeof raw[key] === 'number' && Number.isInteger(raw[key]) && Math.abs(raw[key] as number) < 100000) ||
        (raw.width as number) < 200 || (raw.width as number) > 1000 || (raw.height as number) < 200 || (raw.height as number) > 1400) throw new Error('Invalid bounds');
    bounds = { x: raw.x as number, y: raw.y as number,
      width: Number(value.schemaVersion) === 1 ? COMPACT_SIZE.width : Math.max(COMPACT_SIZE.width, raw.width as number),
      height: Number(value.schemaVersion) === 1 ? COMPACT_SIZE.height : Math.max(COMPACT_SIZE.height, raw.height as number) };
  }
  // An invalid calibration only costs a re-entered reading; it never resets the other preferences.
  const remote = value.remoteDisk;
  let remoteDisk: RemoteDisk | null = null;
  if (remote !== null && remote !== undefined) {
    if (!record(remote) || !validHost(remote.host) || !validLabel(remote.label)) throw new Error('Invalid remote disk preference');
    remoteDisk = { host: remote.host, label: remote.label.trim() };
  }
  if (value.localDiskLabel !== null && value.localDiskLabel !== undefined && !validLabel(value.localDiskLabel)) throw new Error('Invalid disk label preference');
  return { schemaVersion: 3, pinned: false, theme: value.theme as Theme, bounds, codexPath: nativePath(value.codexPath), lastCodexPath: nativePath(value.lastCodexPath),
    claudeCalibration: parseCalibration(value.claudeCalibration), projectsRoot: folder(value.projectsRoot), grokcliRoot: folder(value.grokcliRoot),
    localDiskLabel: typeof value.localDiskLabel === 'string' ? value.localDiskLabel.trim() : null, remoteDisk };
}
export function clampBounds(bounds: Bounds | null, workAreas: Bounds[]): Bounds {
  const first = workAreas[0] || { x: 0, y: 0, width: 1280, height: 720 };
  const candidate = bounds || { x: first.x + first.width - FIRST_LAUNCH_SIZE.width - 20, y: first.y + 40, ...FIRST_LAUNCH_SIZE };
  const intersection = (area: Bounds) => Math.max(0, Math.min(candidate.x + candidate.width, area.x + area.width) - Math.max(candidate.x, area.x)) *
    Math.max(0, Math.min(candidate.y + candidate.height, area.y + area.height) - Math.max(candidate.y, area.y));
  const target = [...workAreas].sort((a, b) => intersection(b) - intersection(a))[0] || first;
  const width = Math.min(candidate.width, target.width);
  const height = Math.min(candidate.height, target.height);
  return { x: Math.round(Math.min(Math.max(candidate.x, target.x), target.x + target.width - width)),
    y: Math.round(Math.min(Math.max(candidate.y, target.y), target.y + target.height - height)), width, height };
}
export class PreferenceStore {
  notice: string | null = null;
  // True when no settings file existed, so the widget opens Settings once for a new user.
  fresh = false;
  private chain: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async load(): Promise<Preferences> {
    await fs.mkdir(this.directory, { recursive: true });
    const current = path.join(this.directory, 'settings.json');
    try { return parsePreferences(JSON.parse(await fs.readFile(current, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.fresh = true; return defaults(); }
      try { await fs.copyFile(current, path.join(this.directory, 'settings.recovery.json')); }
      catch { this.notice = 'Settings could not be read; using defaults.'; return defaults(); }
      try {
        const prior = parsePreferences(JSON.parse(await fs.readFile(path.join(this.directory, 'settings.previous.json'), 'utf8')));
        this.notice = 'Recovered previous preferences; original settings preserved.';
        return prior;
      } catch { this.notice = 'Settings reset to defaults; original settings preserved.'; return defaults(); }
    }
  }
  save(preferences: Preferences): Promise<void> {
    const clean = parsePreferences(preferences);
    this.chain = this.chain.catch(() => undefined).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const current = path.join(this.directory, 'settings.json');
      try {
        const onDisk = JSON.parse(await fs.readFile(current, 'utf8'));
        parsePreferences(onDisk);
        // The first schema 3 write keeps a one-time copy, because releases before 0.7.0 reject schema 3.
        if (Number(onDisk.schemaVersion) < 3) await fs.copyFile(current, path.join(this.directory, 'settings.pre-v3.json'), fsConstants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await fs.copyFile(current, path.join(this.directory, 'settings.previous.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          try { await fs.copyFile(current, path.join(this.directory, 'settings.recovery.json')); }
          catch { /* Main reports any final write failure through the returned promise. */ }
        }
      }
      const temporary = path.join(this.directory, 'settings.tmp');
      await fs.writeFile(temporary, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(temporary, current);
    });
    return this.chain;
  }
  async flush(): Promise<void> { await this.chain; }
}
