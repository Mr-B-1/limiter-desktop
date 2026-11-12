import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { diskIds, emptyStorage, validHost, type DiskId, type DiskSpace, type StorageState } from '../shared/storage.js';

const runFile = promisify(execFile);
export const STORAGE_INTERVAL_MS = 5 * 60_000;
type Reader = (signal: AbortSignal) => Promise<DiskSpace>;
// What the disk rows show; main builds it from the user's settings on every read, so a changed setting applies at the next refresh.
export interface StorageConfig { localLabel: string; localVolume: string; remote: { host: string; label: string } | null }

function checked(totalBytes: number, freeBytes: number): DiskSpace {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(freeBytes) || freeBytes < 0 || freeBytes > totalBytes)
    throw new Error('Invalid disk-space reading');
  return { totalBytes, freeBytes };
}

export async function readLocal(volume: string): Promise<DiskSpace> {
  const disk = await statfs(volume.replace(/[\\/]*$/, '') + '/', { bigint: true });
  return checked(Number(disk.bsize * disk.blocks), Number(disk.bsize * disk.bavail));
}

export function parseRemoteDf(output: string): DiskSpace {
  const match = /^\s*1B-blocks[ \t]+Avail[ \t]*\r?\n[ \t]*(\d+)[ \t]+(\d+)[ \t]*$/.exec(output.trim());
  if (!match) throw new Error('Unexpected remote disk response');
  return checked(Number(match[1]), Number(match[2]));
}

export async function readRemote(host: string, signal: AbortSignal): Promise<DiskSpace> {
  if (!validHost(host)) throw new Error('Remote disk host is not a plain SSH host name');
  // Use the user's existing trusted host entry. Never prompt, change a host key, forward an agent, or install a remote service.
  const ssh = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const { stdout } = await runFile(ssh, ['-n', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', '--', host, 'LC_ALL=C df -B1 --output=size,avail /'],
  { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 4096, signal });
  return parseRemoteDf(stdout);
}

export class StorageProvider {
  private readonly values = emptyStorage();
  private timer?: NodeJS.Timeout;
  private active?: { controller: AbortController; done: Promise<void> };
  private paused = false;
  private stopped = false;
  private remoteHost: string | null = null;
  constructor(private readonly changed: () => void, private readonly config: () => StorageConfig,
    private readonly readers: Record<DiskId, Reader> = {
      local: () => readLocal(config().localVolume),
      remote: signal => { const remote = config().remote; return remote ? readRemote(remote.host, signal) : Promise.reject(new Error('Remote disk off')); }
    },
    private readonly now: () => number = Date.now) {}

  state(): StorageState {
    const config = this.config();
    const result: StorageState = {
      local: { ...this.values.local, label: config.localLabel, volume: config.localVolume },
      remote: config.remote ? { ...this.values.remote, label: config.remote.label, volume: '/' } : { status: 'off', reading: null, label: 'Remote', volume: '/' }
    };
    for (const id of diskIds) {
      const { reading, status } = result[id];
      if (reading && status === 'ready' && this.now() - reading.observedAt >= 2 * STORAGE_INTERVAL_MS)
        result[id] = { ...result[id], status: 'stale' };
    }
    return result;
  }
  start(): void {
    if (this.timer || this.paused || this.stopped) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, STORAGE_INTERVAL_MS);
  }
  refresh(): Promise<void> {
    const remote = this.config().remote;
    // A new or cleared host never shows the previous host's reading, even one still in flight.
    if ((remote?.host ?? null) !== this.remoteHost) {
      this.remoteHost = remote?.host ?? null;
      this.values.remote = { ...this.values.remote, status: remote ? 'waiting' : 'off', reading: null };
      if (this.active) { this.active.controller.abort(); this.active = undefined; }
    }
    if (this.paused || this.stopped) return Promise.resolve();
    if (this.active) return this.active.done;
    const controller = new AbortController();
    const wanted = diskIds.filter(id => id === 'local' || remote);
    // Publish each result separately so a slow or offline remote host cannot hide the local disk.
    const done = Promise.all(wanted.map(async id => {
      try {
        const { totalBytes, freeBytes } = await this.readers[id](controller.signal);
        const space = checked(totalBytes, freeBytes);
        if (!controller.signal.aborted) this.values[id] = { ...this.values[id], status: 'ready', reading: { ...space, observedAt: this.now() } };
      } catch {
        const reading = this.values[id].reading;
        if (!controller.signal.aborted) this.values[id] = { ...this.values[id], status: reading ? 'stale' : 'unavailable', reading };
      }
      if (!controller.signal.aborted) this.changed();
    })).then(() => undefined).finally(() => { if (this.active?.controller === controller) this.active = undefined; });
    this.active = { controller, done };
    return done;
  }
  pause(): void {
    this.paused = true;
    clearInterval(this.timer); this.timer = undefined;
    this.active?.controller.abort(); this.active = undefined;
  }
  resume(): void { if (this.paused && !this.stopped) { this.paused = false; this.start(); } }
  async stop(): Promise<void> { this.stopped = true; const pending = this.active?.done; this.pause(); await pending; }
}
