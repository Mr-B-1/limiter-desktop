import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { record } from './protocol.js';
import { OUTSIDE_LABEL, projectLabel, type ProjectCoverage, type ProjectRoots } from '../shared/projects.js';
import type { ProjectTotal } from './claude-local.js';

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

// cwd is the session's working folder; it is labelled per the user's projects folder when a list is shown.
export interface CodexEvent { at: number; cwd: string | null; units: number; tokens: number; }
interface Counters { input: number; cached: number; output: number; total: number; }
interface SessionState { id: string; cwd: string | null; previous: Counters | null; events: CodexEvent[]; }
interface FileState {
  size: number; mtimeMs: number; offset: number; tail: Buffer; skipping: boolean;
  status: 'read' | 'skipped' | 'unreadable'; malformed: number; parsed: number;
  sessions: Map<string, SessionState>; current: SessionState | null;
}

export function codexSessionsRoot(home = os.homedir()): string {
  return path.join(home, '.codex', 'sessions');
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function counters(usage: Record<string, unknown>): Counters | null {
  if (typeof usage.total_tokens !== 'number' || !Number.isFinite(usage.total_tokens)) return null;
  return { input: count(usage.input_tokens), cached: count(usage.cached_input_tokens), output: count(usage.output_tokens), total: count(usage.total_tokens) };
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
  private owners = new Map<string, string>();
  readonly counts = { offsetReads: 0, fullReads: 0, decompressions: 0 };
  constructor(private readonly root: string, private readonly maxLineBytes = MAX_LINE_BYTES) {}

  async scan(now: number): Promise<void> {
    const since = now - LOOKBACK_MS;
    await fs.access(this.root);
    const present = new Set<string>();
    for (const file of await this.list(this.root, 0)) {
      let stat;
      try { stat = await fs.stat(file); } catch { continue; }
      if (stat.mtimeMs < since) continue;
      present.add(file);
      try { await this.read(file, stat.size, stat.mtimeMs); }
      catch { this.files.set(file, this.blank(stat.size, stat.mtimeMs, 'unreadable')); }
    }
    for (const file of this.files.keys()) if (!present.has(file)) this.files.delete(file);
    this.assignOwners();
  }
  private async list(directory: string, depth: number): Promise<string[]> {
    if (depth > MAX_DEPTH) return [];
    const result: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await this.list(full, depth + 1));
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst'))) result.push(full);
    }
    return result;
  }
  private blank(size: number, mtimeMs: number, status: FileState['status'] = 'read'): FileState {
    return { size, mtimeMs, offset: 0, tail: Buffer.alloc(0), skipping: false, status, malformed: 0, parsed: 0, sessions: new Map(), current: null };
  }
  private async read(file: string, size: number, mtimeMs: number): Promise<void> {
    const existing = this.files.get(file);
    if (existing && existing.size === size && existing.mtimeMs === mtimeMs) return;
    if (file.endsWith('.zst')) {
      const state = this.blank(size, mtimeMs);
      this.files.set(file, state);
      const bytes = await fs.readFile(file);
      let text: Buffer;
      try { text = zlib.zstdDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES }); this.counts.decompressions++; }
      catch { state.status = 'skipped'; return; }
      this.consume(state, text, true);
      this.finish(state);
      return;
    }
    // Growth of a file already read continues at its offset; any other change replaces the file's contributions.
    let state = existing;
    if (!state || size < state.offset || (size === state.size && mtimeMs !== state.mtimeMs) || mtimeMs < state.mtimeMs) {
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
        this.consume(state, chunk.subarray(0, bytesRead), false);
      }
    } finally { await handle.close(); }
    this.finish(state);
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
    if (data.length > this.maxLineBytes) { state.skipping = true; data = Buffer.alloc(0); }
    state.tail = Buffer.from(data);
  }
  private finish(state: FileState): void {
    if (state.status === 'read' && state.parsed === 0 && state.malformed > 0) state.status = 'skipped';
  }
  private line(state: FileState, bytes: Buffer): void {
    if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 13)) return;
    let entry: unknown;
    try { entry = JSON.parse(bytes.toString('utf8')); } catch { state.malformed++; return; }
    if (!record(entry)) { state.malformed++; return; }
    state.parsed++;
    const payload = record(entry.payload) ? entry.payload : null;
    if (entry.type === 'session_meta' && payload) {
      const id = typeof payload.id === 'string' && payload.id ? payload.id : typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
      if (!id) return;
      const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd.slice(0, 1024) : null;
      const session = state.sessions.get(id) || { id, cwd, previous: null, events: [] };
      session.cwd = cwd;
      state.sessions.set(id, session);
      state.current = session;
      return;
    }
    if (!payload || payload.type !== 'token_count' || !record(payload.info) || !record(payload.info.total_token_usage)) return;
    const current = counters(payload.info.total_token_usage);
    if (!current) return;
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(at)) return;
    if (!state.current) {
      // Token events before any session record form an anonymous session.
      state.current = { id: '', cwd: null, previous: null, events: [] };
      state.sessions.set('', state.current);
    }
    const session = state.current;
    const delta = increment(session.previous, current);
    session.previous = current;
    const units = weightedUnits(delta);
    if (units > 0 || delta.total > 0) session.events.push({ at, cwd: session.cwd, units, tokens: delta.total });
  }
  // One logical session can appear in two files (a plain rollout and its compressed copy); the newest file owns it.
  private assignOwners(): void {
    this.owners.clear();
    const newest = new Map<string, number>();
    for (const [file, state] of this.files) {
      if (state.status !== 'read') continue;
      for (const id of state.sessions.keys()) {
        const key = id || file;
        if (!newest.has(key) || state.mtimeMs > newest.get(key)!) { newest.set(key, state.mtimeMs); this.owners.set(key, file); }
      }
    }
  }
  events(from: number, to: number): CodexEvent[] {
    const result: CodexEvent[] = [];
    for (const [key, file] of this.owners) {
      const session = this.files.get(file)?.sessions.get(key === file ? '' : key);
      if (!session) continue;
      for (const event of session.events) if (event.at >= from && event.at < to) result.push(event);
    }
    return result.sort((a, b) => a.at - b.at);
  }
  byProject(from: number, to: number, roots: ProjectRoots): ProjectTotal[] {
    const totals = new Map<string, ProjectTotal>();
    for (const event of this.events(from, to)) {
      // Token events with no session record belong to an anonymous session outside any project.
      const name = event.cwd === null ? OUTSIDE_LABEL : projectLabel(event.cwd, roots);
      const total = totals.get(name) || { name, units: 0, tokens: 0 };
      total.units += event.units; total.tokens += event.tokens;
      totals.set(name, total);
    }
    return [...totals.values()].sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
  }
  coverage(): ProjectCoverage {
    const result: ProjectCoverage = { files: this.files.size, read: 0, skipped: 0, unreadable: 0, withoutTokens: 0, malformedLines: 0, sessions: this.owners.size };
    for (const state of this.files.values()) {
      result[state.status]++;
      result.malformedLines += state.malformed;
    }
    for (const [key, file] of this.owners) {
      const session = this.files.get(file)?.sessions.get(key === file ? '' : key);
      if (session && session.events.length === 0) result.withoutTokens++;
    }
    return result;
  }
}
