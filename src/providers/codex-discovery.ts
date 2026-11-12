import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { RpcClient, SourceError, record } from './protocol.js';

const exec = promisify(execFile);
export type Candidate = { path: string; version: string; schemaHash: string; arch: string };
export async function candidatePaths(explicit?: string, previous?: string): Promise<string[]> {
  const result = [explicit, previous].filter((value): value is string => Boolean(value));
  const pathValue = process.env.PATH || '';
  for (const directory of pathValue.split(path.delimiter)) if (directory) result.push(path.join(directory, 'codex.exe'));
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const bundled = path.join(local, 'OpenAI', 'Codex', 'bin');
    try {
      const versions = await fs.readdir(bundled, { withFileTypes: true });
      const candidates = await Promise.all(versions.filter(entry => entry.isDirectory()).map(async entry => {
        const filename = path.join(bundled, entry.name, 'codex.exe');
        return { filename, time: (await fs.stat(filename).catch(() => null))?.mtimeMs || 0 };
      }));
      for (const candidate of candidates.sort((a, b) => b.time - a.time || a.filename.localeCompare(b.filename))) result.push(candidate.filename);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SourceError('unavailable'); }
  }
  const target = process.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64';
  const extensionRoot = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const extensions = (await fs.readdir(extensionRoot)).filter(name => name.startsWith('openai.chatgpt-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of extensions) result.push(path.join(extensionRoot, name, 'bin', target, 'codex.exe'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SourceError('unavailable'); }
  const roaming = process.env.APPDATA;
  if (roaming) result.push(path.join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'vendor', process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'));
  return [...new Set(result.filter(value => path.isAbsolute(value) && path.extname(value).toLowerCase() === '.exe'))];
}
export async function nativeExecutable(filename: string, architecture = process.arch): Promise<boolean> {
  if (!path.isAbsolute(filename) || path.basename(filename).toLowerCase() !== 'codex.exe') return false;
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const header = Buffer.alloc(64);
    await handle.read(header, 0, 64, 0);
    if (header.toString('ascii', 0, 2) !== 'MZ') return false;
    const offset = header.readUInt32LE(60);
    if (offset > 1024 * 1024) return false;
    const pe = Buffer.alloc(6);
    await handle.read(pe, 0, 6, offset);
    return pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === (architecture === 'arm64' ? 0xaa64 : 0x8664);
  } catch { return false; }
  finally { await handle?.close(); }
}
export async function validateCandidate(filename: string, stateRoot: string, signal?: AbortSignal): Promise<Candidate> {
  if (!(await nativeExecutable(filename))) throw new SourceError('unavailable');
  const options = { signal, windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024, encoding: 'utf8' as const };
  const { stdout } = await exec(filename, ['--version'], options);
  const version = /^codex-cli ([0-9A-Za-z.+-]+)\s*$/.exec(stdout)?.[1];
  if (!version) throw new SourceError('compatibility');
  const help = await exec(filename, ['app-server', '--help'], options);
  if (!help.stdout.includes('--stdio')) throw new SourceError('compatibility');
  await fs.mkdir(stateRoot, { recursive: true });
  const schemaDir = await fs.mkdtemp(path.join(stateRoot, 'protocol-'));
  try {
  await exec(filename, ['app-server', 'generate-json-schema', '--out', schemaDir], options);
  const text = await fs.readFile(path.join(schemaDir, 'v2', 'GetAccountRateLimitsResponse.json'), 'utf8');
  const schema: unknown = JSON.parse(text);
  if (!record(schema) || !record(schema.definitions) || !record(schema.definitions.RateLimitWindow)) throw new SourceError('compatibility');
  const window = schema.definitions.RateLimitWindow;
  const properties = window.properties;
  if (!record(properties) || !record(properties.usedPercent) || properties.usedPercent.type !== 'integer' ||
      !Array.isArray(window.required) || !window.required.includes('usedPercent')) throw new SourceError('compatibility');
  for (const name of ['resetsAt', 'windowDurationMins']) {
    const property = properties[name];
    if (!record(property) || !Array.isArray(property.type) || property.type.length !== 2 ||
        !property.type.includes('integer') || !property.type.includes('null')) throw new SourceError('compatibility');
  }
  const client = await fs.readFile(path.join(schemaDir, 'ClientRequest.json'), 'utf8');
  for (const method of ['initialize', 'account/read', 'account/rateLimits/read']) {
    if (!client.includes('"' + method + '"')) throw new SourceError('compatibility');
  }
  const candidate = { path: filename, version, schemaHash: createHash('sha256').update(text).digest('hex'), arch: process.arch };
  await fs.writeFile(path.join(stateRoot, 'protocol-profile.json'), JSON.stringify(candidate, null, 2));
  return candidate;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SourceError('compatibility');
  } finally {
    const realRoot = await fs.realpath(stateRoot);
    const realScratch = await fs.realpath(schemaDir);
    if (path.dirname(realScratch).toLowerCase() !== realRoot.toLowerCase() || !path.basename(realScratch).startsWith('protocol-')) throw new SourceError('compatibility');
    await fs.rm(realScratch, { recursive: true });
  }
}
export async function connectCodex(stateRoot: string, explicit?: string, previous?: string, signal?: AbortSignal): Promise<{ candidate: Candidate; client: RpcClient }> {
  const deadline = AbortSignal.timeout(30000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const paths = await candidatePaths(explicit, previous);
  let failure: SourceError = new SourceError('unavailable');
  for (const filename of paths) {
    if (combined.aborted) throw new SourceError(signal?.aborted ? 'stopped' : 'timeout');
    let client: RpcClient | undefined;
    try {
      const candidate = await validateCandidate(filename, stateRoot, combined);
      client = new RpcClient(filename, ['app-server', '--stdio'], 15000, signal);
      const abortHandshake = () => { void client?.close(); };
      combined.addEventListener('abort', abortHandshake, { once: true });
      try { await client.initialize(); }
      finally { combined.removeEventListener('abort', abortHandshake); }
      if (combined.aborted) { await client.close(); throw new SourceError(signal?.aborted ? 'stopped' : 'timeout'); }
      return { candidate, client };
    } catch (error) {
      if (error instanceof SourceError && error.kind === 'compatibility') failure = error;
      await client?.close();
      if (combined.aborted) throw new SourceError(signal?.aborted ? 'stopped' : 'timeout');
    }
  }
  throw failure;
}
