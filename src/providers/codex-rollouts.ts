import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, type Hash } from 'node:crypto';
import { record } from './protocol.js';
import { OUTSIDE_LABEL, projectKey, projectLabel, type ProjectCoverage, type ProjectRoots } from '../shared/projects.js';
import type { ProjectTotal } from './claude-local.js';
import { projectInputFile, type ProjectInputFile } from '../services/project-input.js';

// Codex rollouts (~/.codex/sessions/**) carry one session each: a session_meta record with the working folder, then
// token_count events whose total_token_usage counters are cumulative for the session (survey receipt
// Support/2026-10-21-codex-rollout-survey.json: 98.6% monotonic, 15 sessions reset mid-way). Only labels, times and counts leave this file.

// GPT-5 list-price ratios per million tokens, one table for every Codex model (plan decision D9); the share is what matters.
export const CODEX_WEIGHTS = { uncachedInput: 1.25, cachedInput: 0.125, output: 10 } as const;
export const LOOKBACK_MS = 8 * 86400000;
const CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_LINE_BYTES = 32 * 1024 * 1024;
// Compressed rollouts decode whole; the largest plain rollout seen in the survey was 32 MB.
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 8;

// cwd is the effective turn folder, falling back to the owning session's folder.
export interface CodexEvent { at: number; cwd: string | null; units: number; tokens: number; }
interface Counters { input: number; cached: number; output: number; total: number; }
interface SessionMeta { id: string; cwd: string | null; parent: string | null; }
interface Observation {
  at: number; cwd: string | null; turn: string | null; current: Counters;
  key: string; replayKey: string | null; fresh: boolean;
}
interface SessionState { meta: SessionMeta; observations: Observation[]; sources: string[]; events: CodexEvent[]; }
interface FileState {
  size: number; mtimeMs: number; offset: number; tail: Buffer; skipping: boolean;
  status: 'read' | 'skipped' | 'unreadable'; malformed: number; parsed: number;
  metadata: Map<string, SessionMeta>; observations: Observation[]; cwd: string | null; turn: string | null;
}

// Validate before normalization: Windows drive-relative and device paths are not working directories.
function folder(value: unknown): string | null {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) return null;
  let windows = value.replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(windows)) windows = '\\\\' + windows.slice(8);
  else if (/^\\\\\?\\[a-z]:\\/i.test(windows)) windows = windows.slice(4);
  if (/^[a-z]:\\/i.test(windows) || /^\\\\(?![?.]\\)[^\\]+\\[^\\]+(?:\\|$)/.test(windows)) return path.win32.normalize(windows);
  return value.startsWith('/') && !value.startsWith('//') ? path.posix.normalize(value) : null;
}
function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}
function sessionId(value: unknown): string | null {
  const id = identifier(value);
  return id && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id.toLowerCase() : id;
}
function fileSession(file: string): string | null {
  return /([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl(?:\.zst)?$/i.exec(path.basename(file))?.[1].toLowerCase() ?? null;
}
export function codexSessionsRoot(home = os.homedir(), codexHome = process.env.CODEX_HOME): string {
  return path.join(folder(codexHome) ?? path.join(home, '.codex'), 'sessions');
}
export function codexRolloutRoots(home = os.homedir(), codexHome = process.env.CODEX_HOME): string[] {
  const sessions = codexSessionsRoot(home, codexHome);
  return [sessions, path.join(path.dirname(sessions), 'archived_sessions')];
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function counters(usage: Record<string, unknown>): Counters | null {
  if (typeof usage.total_tokens !== 'number' || !Number.isFinite(usage.total_tokens)) return null;
  return { input: count(usage.input_tokens), cached: count(usage.cached_input_tokens), output: count(usage.output_tokens), total: count(usage.total_tokens) };
}
function tuple(usage: Record<string, unknown>): string {
  return JSON.stringify([count(usage.input_tokens), count(usage.cached_input_tokens), count(usage.output_tokens),
    count(usage.reasoning_output_tokens), count(usage.total_tokens)]);
}
// Copies may overlap by a prefix, suffix, or contained run. Conflicting branches cannot be added together.
function overlap(first: Observation[], second: Observation[]): Observation[] | null {
  if (!first.length) return second;
  if (!second.length) return first;
  if (first.length === second.length && first.every((item, index) => item.key === second[index].key)) return first;
  const positions = new Map<string, number>();
  for (let index = 0; index < second.length; index++) {
    if (positions.has(second[index].key)) return null;
    positions.set(second[index].key, index);
  }
  let left = -1, right = -1;
  const seen = new Set<string>();
  for (let index = 0; index < first.length; index++) {
    if (seen.has(first[index].key)) return null;
    seen.add(first[index].key);
    if (left < 0 && positions.has(first[index].key)) { left = index; right = positions.get(first[index].key)!; }
  }
  if (left < 0 || (left > 0 && right > 0)) return null;
  let offset = 0;
  while (left + offset < first.length && right + offset < second.length) {
    if (first[left + offset].key !== second[right + offset].key) return null;
    offset++;
  }
  return [...(left > 0 ? first.slice(0, left) : second.slice(0, right)), ...first.slice(left, left + offset),
    ...(left + offset < first.length ? first.slice(left + offset) : second.slice(right + offset))];
}
// Weighted units for one increment; cached input sits inside input_tokens and reasoning inside output_tokens (survey receipt).
export function weightedUnits(delta: Counters): number {
  const uncached = Math.max(0, delta.input - delta.cached);
  return (uncached * CODEX_WEIGHTS.uncachedInput + delta.cached * CODEX_WEIGHTS.cachedInput + delta.output * CODEX_WEIGHTS.output) / 1e6;
}
// The increment since the previous event: the counters themselves after a reset, else the per-class growth clamped at zero
// (four events in two August sessions lowered a class counter while the total rose; the clamp keeps them from going negative).
export function increment(previous: Counters | null, current: Counters): Counters {
  if (!previous || current.total < previous.total) return { ...current };
  return { input: Math.max(0, current.input - previous.input), cached: Math.max(0, current.cached - previous.cached),
    output: Math.max(0, current.output - previous.output), total: Math.max(0, current.total - previous.total) };
}

export class CodexRolloutReader {
  private files = new Map<string, FileState>();
  private sessions = new Map<string, SessionState>();
  private incomplete = new Set<string>();
  private scanned = false;
  readonly roots: readonly string[];
  readonly counts = { offsetReads: 0, fullReads: 0, decompressions: 0 };
  readonly issues = { conflictingCopies: 0, unresolvedForks: 0, lineageCycles: 0, nonPrefixReplays: 0 };
  constructor(root: string | readonly string[], private readonly maxLineBytes = MAX_LINE_BYTES) {
    this.roots = typeof root === 'string' ? [root] : [...root];
  }

  async scan(now: number, audit?: ProjectInputFile[]): Promise<void> {
    if (audit && this.scanned) throw new Error('Codex input proof requires a fresh reader');
    this.scanned = true;
    const since = now - LOOKBACK_MS;
    const available = new Map<string, { size: number; mtimeMs: number }>();
    const parents = new Map<string, string[]>();
    for (const [index, root] of this.roots.entries()) {
      try { await fs.access(root); }
      catch (error) { if (index > 0 && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const file of await this.list(root, 0)) {
        let stat;
        try { stat = await fs.stat(file); } catch (error) { if (audit) throw error; continue; }
        available.set(file, stat);
        const id = fileSession(file);
        if (id) parents.set(id, [...parents.get(id) ?? [], file]);
      }
    }
    const present = new Set<string>();
    const pending = [...available].filter(([, stat]) => stat.mtimeMs >= since).map(([file]) => file);
    for (let index = 0; index < pending.length; index++) {
      const file = pending[index];
      if (present.has(file)) continue;
      const stat = available.get(file)!;
      present.add(file);
      try { await this.read(file, stat.size, stat.mtimeMs, audit); }
      catch (error) { this.files.set(file, this.blank(stat.size, stat.mtimeMs, 'unreadable')); if (audit) throw error; }
      const owner = this.owner(file, this.files.get(file)!);
      for (const id of [owner.id, owner.parent]) if (id) pending.push(...parents.get(id.toLowerCase()) ?? []);
    }
    for (const file of this.files.keys()) if (!present.has(file)) this.files.delete(file);
    this.combine();
    const coverage = this.coverage();
    if (audit && (coverage.skipped || coverage.unreadable || coverage.malformedLines)) throw new Error('Codex input proof is incomplete');
  }
  private async list(directory: string, depth: number): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];
    const result: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await this.list(full, depth + 1));
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst'))) result.push(full);
    }
    return result;
  }
  private blank(size: number, mtimeMs: number, status: FileState['status'] = 'read'): FileState {
    return { size, mtimeMs, offset: 0, tail: Buffer.alloc(0), skipping: false, status, malformed: 0, parsed: 0,
      metadata: new Map(), observations: [], cwd: null, turn: null };
  }
  private async read(file: string, size: number, mtimeMs: number, audit?: ProjectInputFile[]): Promise<void> {
    const proof: Hash | undefined = audit ? createHash('sha256') : undefined;
    const existing = this.files.get(file);
    if (existing && existing.status !== 'unreadable' && existing.size === size && existing.mtimeMs === mtimeMs) return;
    if (file.endsWith('.zst')) {
      const state = this.blank(size, mtimeMs);
      this.files.set(file, state);
      const bytes = await fs.readFile(file);
      if (audit && bytes.length !== size) throw new Error('Codex compressed input changed during proof');
      proof?.update(bytes);
      let text: Buffer;
      try { text = zlib.zstdDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES }); this.counts.decompressions++; }
      catch { state.status = 'skipped'; return; }
      this.consume(state, text, true);
      this.finish(state);
      if (audit && proof) audit.push(projectInputFile(file, bytes.length, mtimeMs, proof));
      return;
    }
    // Growth of a file already read continues at its offset; any other change replaces the file's contributions.
    let state = existing;
    if (!state || state.status === 'unreadable' || size < state.offset || (size === state.size && mtimeMs !== state.mtimeMs) || mtimeMs < state.mtimeMs) {
      state = this.blank(size, mtimeMs);
      this.files.set(file, state);
      this.counts.fullReads++;
    } else this.counts.offsetReads++;
    state.size = size; state.mtimeMs = mtimeMs; state.status = 'read';
    const handle = await fs.open(file, 'r');
    try {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      while (state.offset < size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - state.offset), state.offset);
        if (bytesRead === 0) break;
        state.offset += bytesRead;
        proof?.update(chunk.subarray(0, bytesRead));
        this.consume(state, chunk.subarray(0, bytesRead), false);
      }
    } finally { await handle.close(); }
    this.finish(state);
    if (audit && proof) {
      if (state.offset !== size) throw new Error('Codex input ended before its proof boundary');
      audit.push(projectInputFile(file, size, mtimeMs, proof));
    }
  }
  // Splits complete lines off the buffer; an unterminated last line waits in the tail for the next append.
  private consume(state: FileState, bytes: Buffer, whole: boolean): void {
    let data = state.tail.length ? Buffer.concat([state.tail, bytes]) : bytes;
    let start = 0;
    let newline: number;
    while ((newline = data.indexOf(10, start)) >= 0) {
      if (!state.skipping) this.line(state, data.subarray(start, newline));
      state.skipping = false;
      start = newline + 1;
    }
    data = data.subarray(start);
    if (whole && data.length) { this.line(state, data); data = Buffer.alloc(0); }
    if (data.length > this.maxLineBytes) { if (!state.skipping) state.malformed++; state.skipping = true; data = Buffer.alloc(0); }
    state.tail = Buffer.from(data);
  }
  private finish(state: FileState): void {
    if (state.status === 'read' && state.parsed === 0 && state.malformed > 0) state.status = 'skipped';
  }
  private line(state: FileState, bytes: Buffer): void {
    if (bytes.length > this.maxLineBytes) { state.malformed++; return; }
    if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 13)) return;
    let entry: unknown;
    try { entry = JSON.parse(bytes.toString('utf8')); } catch { state.malformed++; return; }
    if (!record(entry)) { state.malformed++; return; }
    state.parsed++;
    const payload = record(entry.payload) ? entry.payload : null;
    if (entry.type === 'session_meta' && payload) {
      const id = sessionId(payload.id) ?? sessionId(payload.session_id);
      if (!id) return;
      if (!state.metadata.has(id)) state.metadata.set(id, { id, cwd: folder(payload.cwd), parent: sessionId(payload.forked_from_id) });
      return;
    }
    if (entry.type === 'turn_context' && payload) {
      state.cwd = folder(payload.cwd);
      state.turn = identifier(payload.turn_id);
      return;
    }
    if (entry.type !== 'event_msg' || !payload || payload.type !== 'token_count' || !record(payload.info) || !record(payload.info.total_token_usage)) return;
    const current = counters(payload.info.total_token_usage);
    if (!current) return;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at)) return;
    const total = tuple(payload.info.total_token_usage);
    const last = record(payload.info.last_token_usage) && counters(payload.info.last_token_usage) ? tuple(payload.info.last_token_usage) : null;
    const replayKey = state.turn && last ? JSON.stringify([state.turn, total, last]) : null;
    state.observations.push({ at, cwd: state.cwd, turn: state.turn, current,
      key: JSON.stringify([at, state.turn, total, last]), replayKey, fresh: last !== null && total === last });
  }
  private owner(file: string, state: FileState): SessionMeta {
    const expected = fileSession(file);
    if (expected) return state.metadata.get(expected) ?? { id: expected, cwd: null, parent: null };
    return state.metadata.values().next().value ?? { id: '', cwd: null, parent: null };
  }
  private combine(): void {
    this.sessions.clear();
    this.incomplete.clear();
    this.issues.conflictingCopies = 0; this.issues.unresolvedForks = 0; this.issues.lineageCycles = 0; this.issues.nonPrefixReplays = 0;
    const copies = new Map<string, { file: string; state: FileState; meta: SessionMeta; canonical: boolean }[]>();
    for (const [file, state] of this.files) {
      if (state.status !== 'read') continue;
      const meta = this.owner(file, state);
      const key = meta.id || file;
      const list = copies.get(key) ?? [];
      list.push({ file, state, meta, canonical: fileSession(file) === meta.id.toLowerCase() });
      copies.set(key, list);
    }
    for (const [key, list] of copies) {
      list.sort((a, b) => Number(b.canonical) - Number(a.canonical) || b.state.observations.length - a.state.observations.length
        || (b.state.observations.at(-1)?.at ?? 0) - (a.state.observations.at(-1)?.at ?? 0) || a.file.localeCompare(b.file));
      const preferred = list[0];
      // Fallback cwd belongs to each original copy, not whichever file happens to be touched last.
      const observations = (item: typeof preferred) => item.state.observations.map(event => ({ ...event, cwd: event.cwd ?? item.meta.cwd }));
      let merged = observations(preferred);
      const pending = list.slice(1);
      let changed = true;
      while (changed && pending.length) {
        changed = false;
        for (let index = 0; index < pending.length;) {
          const next = overlap(merged, observations(pending[index]));
          if (next) { merged = next; pending.splice(index, 1); changed = true; }
          else index++;
        }
      }
      for (const item of pending) this.incomplete.add(item.file);
      this.issues.conflictingCopies += pending.length;
      // A truncated canonical copy may lack its own metadata; an agreeing copy can supply that same owner's lineage.
      const meta = list.find(item => !pending.includes(item) && item.state.metadata.has(item.meta.id))?.meta ?? preferred.meta;
      merged = merged.map(event => ({ ...event, cwd: event.cwd ?? meta.cwd }));
      this.sessions.set(key, { meta, observations: merged, sources: list.map(item => item.file), events: [] });
    }
    for (const session of this.sessions.values()) {
      const parent = session.meta.parent ? this.sessions.get(session.meta.parent) : undefined;
      const lineage = new Set([session.meta.id]);
      const ancestors: SessionState[] = [];
      let ancestor = parent, cycle = false, missing = !!session.meta.parent && !parent;
      while (ancestor) {
        if (lineage.has(ancestor.meta.id)) { cycle = true; break; }
        lineage.add(ancestor.meta.id);
        ancestors.push(ancestor);
        const parentId = ancestor.meta.parent;
        ancestor = parentId ? this.sessions.get(parentId) : undefined;
        if (parentId && !ancestor) missing = true;
      }
      if (cycle && session.observations.length) {
        this.issues.lineageCycles++;
        for (const file of session.sources) this.incomplete.add(file);
      }
      let inherited = 0;
      if (!cycle && session.observations[0]?.replayKey) {
        const first = session.observations[0].replayKey;
        for (const source of ancestors) {
          for (let start = 0; start < source.observations.length; start++) {
            if (source.observations[start].replayKey !== first) continue;
            let length = 0;
            while (length < session.observations.length && start + length < source.observations.length
              && session.observations[length].replayKey !== null
              && session.observations[length].replayKey === source.observations[start + length].replayKey) length++;
            inherited = Math.max(inherited, length);
          }
        }
      }
      const ancestorKeys = new Set(ancestors.flatMap(source => source.observations.map(event => event.replayKey).filter(key => key !== null)));
      const nonPrefix = session.observations.slice(inherited).filter(event => event.replayKey !== null && ancestorKeys.has(event.replayKey)).length;
      if (nonPrefix) {
        this.issues.nonPrefixReplays += nonPrefix;
        for (const file of session.sources) this.incomplete.add(file);
      }
      // Without a proven initial fork baseline, only subsequent observed differences are knowable.
      const unknown = !!session.meta.parent && !!session.observations.length
        && (missing || cycle || (!inherited && !session.observations[0].fresh));
      if (unknown) {
        this.issues.unresolvedForks++;
        for (const file of session.sources) this.incomplete.add(file);
      }
      let previous: Observation | null = null;
      for (const [index, event] of session.observations.entries()) {
        const reset = !!previous?.turn && !!event.turn && previous.turn !== event.turn && event.fresh
          && event.current.total > previous.current.total;
        const delta = increment(reset ? null : previous?.current ?? null, event.current);
        previous = event;
        if (index < inherited || (unknown && index === 0)) continue;
        const units = weightedUnits(delta);
        if (units > 0 || delta.total > 0) session.events.push({ at: event.at, cwd: event.cwd, units, tokens: delta.total });
      }
    }
  }
  events(from: number, to: number): CodexEvent[] {
    const result: CodexEvent[] = [];
    for (const session of this.sessions.values()) {
      for (const event of session.events) if (event.at >= from && event.at < to) result.push(event);
    }
    return result.sort((a, b) => a.at - b.at);
  }
  byProject(from: number, to: number, roots: ProjectRoots): ProjectTotal[] {
    const totals = new Map<string, ProjectTotal>();
    const normalized = { workspace: folder(roots.workspace), codexApp: folder(roots.codexApp) ?? roots.codexApp };
    for (const event of this.events(from, to)) {
      // Token events with no session record belong to an anonymous session outside any project.
      const name = event.cwd === null ? OUTSIDE_LABEL : projectLabel(event.cwd, normalized);
      const key = projectKey(event.cwd, name);
      const total = totals.get(key) || { name, units: 0, tokens: 0 };
      total.units += event.units; total.tokens += event.tokens;
      totals.set(key, total);
    }
    return [...totals.values()].sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
  }
  coverage(): ProjectCoverage {
    const result: ProjectCoverage = { files: this.files.size, read: 0, skipped: 0, unreadable: 0, withoutTokens: 0, malformedLines: 0, sessions: this.sessions.size };
    for (const [file, state] of this.files) {
      result[this.incomplete.has(file) ? 'skipped' : state.status]++;
      result.malformedLines += state.malformed;
    }
    for (const session of this.sessions.values()) if (session.events.length === 0) result.withoutTokens++;
    return result;
  }
}
