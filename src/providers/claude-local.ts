import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { record } from './protocol.js';
import { projectLabel, type ProjectRoots } from '../shared/projects.js';
import type { ClaudeSample, ClaudeState } from './claude.js';

// Anthropic API list prices, USD per million tokens (claude-api skill table cached 2026-10-06).
// Subscription limits are unpublished; list price is the closest public weighting across models,
// and calibration against a real reading absorbs the overall scale. Longest prefix first.
const PRICES: readonly (readonly [prefix: string, input: number, output: number, cacheRead: number])[] = [
  ['claude-fable-5-1', 10, 50, 0.25], ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1], ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2], ['claude-opus-5', 5, 25, 0.5], ['claude-opus-4', 5, 25, 0.5],
  ['claude-sonnet-5', 2, 10, 0.2], ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-5', 0.1, 0.5, 0.01], ['claude-haiku-4', 1, 5, 0.1]];
const FAMILY_FALLBACK: readonly (readonly [RegExp, string])[] = [[/fable|mythos/, 'claude-fable-5-1'], [/opus/, 'claude-opus-5-5'], [/sonnet/, 'claude-sonnet-5'], [/haiku/, 'claude-haiku-5']];
const FAST_MULTIPLIER = 2;
// Cache reads do not count toward Anthropic's API input rate limits, and on October 9, 2026 PST four live readings fit best
// with them excluded (weekly error 0.28 points against 0.89 at list price). Kept as a weight so it can be retuned.
const CACHE_READ_WEIGHT = 0;
// Saved capacities are only comparable under the counting that produced them; bump this whenever usageUnits or de-duplication changes.
export const WEIGHTING = 2;
export const WEEK_MS = 7 * 86400000;
export const FIVE_HOURS_MS = 5 * 3600000;
export const SCAN_INTERVAL_MS = 15 * 60000;
const LOOKBACK_MS = WEEK_MS + 86400000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
// A sample below this is too coarse to set capacity: integer readings carry up to half a point of rounding.
const MIN_ANCHOR_PERCENT = 5;

// cwd is the working folder of the session that produced the reply, labelled per the user's projects folder when a list is shown;
// tokens is the raw count across every class.
export interface UsageEvent { at: number; units: number; known: boolean; cwd: string; tokens: number; }
export interface ProjectTotal { name: string; units: number; tokens: number; }
export interface ClaudeCalibration {
  weeklyCapacity: number | null;
  fiveHourCapacity: number | null;
  weeklyResetAt: number | null;
  fiveHourResetAt: number | null;
  anchoredAt: number;
  source: 'manual' | 'status-line';
  weighting: typeof WEIGHTING;
}
export interface ClaudeReading { weeklyPercent: number | null; weeklyResetAt: number | null; fiveHourPercent: number | null; fiveHourResetAt: number | null; }
export interface ClaudeWindowView { percent: number | null; resetsAt: number | null; }
export interface ClaudeView {
  mode: 'exact' | 'estimate' | 'uncalibrated' | 'scanning' | 'unavailable';
  weekly: ClaudeWindowView;
  fiveHour: ClaudeWindowView;
  ageMs: number | null;
  anchor: { at: number; source: ClaudeCalibration['source'] } | null;
  coverage: { files: number; replies: number; unknownModels: number };
  refreshing: boolean;
  // Which exact feed the row shows, and the host that wrote it; null while estimating.
  exact: { source: 'status-line' | 'mod'; host: string | null } | null;
}

export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return path.join(configured && path.isAbsolute(configured) ? configured : path.join(home, '.claude'), 'projects');
}
function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
export function usageUnits(model: string, usage: Record<string, unknown>): { units: number; known: boolean } {
  let price = PRICES.find(([prefix]) => model.startsWith(prefix));
  const known = !!price;
  if (!price) {
    const family = FAMILY_FALLBACK.find(([pattern]) => pattern.test(model))?.[1] || 'claude-opus-5-5';
    price = PRICES.find(([prefix]) => prefix === family)!;
  }
  const [, input, output, cacheRead] = price;
  const creation = record(usage.cache_creation) ? usage.cache_creation : null;
  const oneHour = tokens(creation?.ephemeral_1h_input_tokens);
  // Older logs report only the cache-write total; treat it as the cheaper 5-minute write.
  const fiveMinute = creation ? tokens(creation.ephemeral_5m_input_tokens) : tokens(usage.cache_creation_input_tokens);
  const dollars = tokens(usage.input_tokens) * input + tokens(usage.output_tokens) * output + tokens(usage.cache_read_input_tokens) * cacheRead * CACHE_READ_WEIGHT +
    fiveMinute * input * 1.25 + oneHour * input * 2;
  return { units: (usage.speed === 'fast' ? FAST_MULTIPLIER : 1) * dollars / 1e6, known };
}
export function rawTokens(usage: Record<string, unknown>): number {
  const creation = record(usage.cache_creation) ? usage.cache_creation : null;
  const written = creation ? tokens(creation.ephemeral_5m_input_tokens) + tokens(creation.ephemeral_1h_input_tokens) : tokens(usage.cache_creation_input_tokens);
  return tokens(usage.input_tokens) + tokens(usage.output_tokens) + tokens(usage.cache_read_input_tokens) + written;
}
// Only usage metadata leaves this function; the rest of the transcript line is discarded.
export function parseLogLine(line: string): { key: string; event: UsageEvent } | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!record(entry) || entry.type !== 'assistant' || !record(entry.message)) return null;
  const message = entry.message;
  if (!record(message.usage) || typeof message.model !== 'string' || message.model === '<synthetic>') return null;
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  // Claude Code writes a reply on several lines as it streams; message id plus request id identifies the reply.
  const id = typeof message.id === 'string' ? message.id : typeof entry.uuid === 'string' ? entry.uuid : null;
  if (!id) return null;
  const { units, known } = usageUnits(message.model, message.usage);
  return { key: id + ':' + (typeof entry.requestId === 'string' ? entry.requestId : ''),
    event: { at, units, known, cwd: typeof entry.cwd === 'string' ? entry.cwd.slice(0, 1024) : '', tokens: rawTokens(message.usage) } };
}

interface Cursor { offset: number; remainder: Buffer; skipping: boolean; }
export class ClaudeLogScanner {
  private cursors = new Map<string, Cursor>();
  private events = new Map<string, UsageEvent>();
  private sorted: UsageEvent[] | null = null;
  files = 0;
  constructor(private readonly root: string) {}
  get replies(): number { return this.events.size; }
  get unknownModels(): number { let count = 0; for (const event of this.events.values()) if (!event.known) count++; return count; }
  async scan(now: number): Promise<void> {
    const since = now - LOOKBACK_MS;
    await fs.access(this.root);
    const present = new Set<string>();
    for (const file of await this.list(this.root, 0)) {
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs < since) continue;
        present.add(file);
        await this.read(file, stat.size);
      } catch { /* A file being replaced is read on the next scan. */ }
    }
    for (const file of this.cursors.keys()) if (!present.has(file)) this.cursors.delete(file);
    for (const [key, event] of this.events) if (event.at < since) this.events.delete(key);
    this.files = present.size;
    this.sorted = null;
  }
  private async list(directory: string, depth: number): Promise<string[]> {
    if (depth > 6) return [];
    const result: string[] = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await this.list(full, depth + 1));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full);
    }
    return result;
  }
  private async read(file: string, size: number): Promise<void> {
    let cursor = this.cursors.get(file);
    // A shorter file was rewritten; rereading is safe because replies are keyed.
    if (!cursor || size < cursor.offset) { cursor = { offset: 0, remainder: Buffer.alloc(0), skipping: false }; this.cursors.set(file, cursor); }
    if (size === cursor.offset) return;
    const handle = await fs.open(file, 'r');
    try {
      const chunk = Buffer.alloc(CHUNK_BYTES);
      while (cursor.offset < size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - cursor.offset), cursor.offset);
        if (bytesRead === 0) break;
        cursor.offset += bytesRead;
        let data = cursor.remainder.length ? Buffer.concat([cursor.remainder, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        let newline: number;
        while ((newline = data.indexOf(10, start)) >= 0) {
          if (!cursor.skipping) this.line(data.subarray(start, newline));
          cursor.skipping = false;
          start = newline + 1;
        }
        data = data.subarray(start);
        if (data.length > MAX_LINE_BYTES) { cursor.skipping = true; data = Buffer.alloc(0); }
        cursor.remainder = Buffer.from(data);
      }
    } finally { await handle.close(); }
  }
  private line(bytes: Buffer): void {
    // Most lines are prompts and tool output; skip decoding them unless they carry usage.
    if (bytes.length < 40 || bytes.indexOf('"usage"') < 0) return;
    const parsed = parseLogLine(bytes.toString('utf8'));
    if (!parsed) return;
    // Input and cache counts repeat on every line of a reply, but output grows until the last line; keep the largest.
    const existing = this.events.get(parsed.key);
    if (!existing) { this.events.set(parsed.key, parsed.event); this.sorted = null; return; }
    // The reply starts at its earliest line, whichever file was read first, and keeps that line's folder.
    const merged = { at: Math.min(existing.at, parsed.event.at), units: Math.max(existing.units, parsed.event.units), known: existing.known && parsed.event.known,
      cwd: existing.cwd, tokens: Math.max(existing.tokens, parsed.event.tokens) };
    if (merged.at !== existing.at || merged.units !== existing.units || merged.tokens !== existing.tokens) { this.events.set(parsed.key, merged); this.sorted = null; }
  }
  // Weighted units and raw tokens per project inside [from, to), largest first.
  byProject(from: number, to: number, roots: ProjectRoots): ProjectTotal[] {
    const totals = new Map<string, ProjectTotal>();
    for (const event of this.timeline()) {
      if (event.at >= to) break;
      if (event.at < from) continue;
      const name = projectLabel(event.cwd, roots);
      const total = totals.get(name) || { name, units: 0, tokens: 0 };
      total.units += event.units; total.tokens += event.tokens;
      totals.set(name, total);
    }
    return [...totals.values()].sort((a, b) => b.units - a.units || a.name.localeCompare(b.name));
  }
  timeline(): UsageEvent[] {
    if (!this.sorted) this.sorted = [...this.events.values()].sort((a, b) => a.at - b.at);
    return this.sorted;
  }
  units(from: number, to: number): number {
    let total = 0;
    for (const event of this.timeline()) { if (event.at >= to) break; if (event.at >= from) total += event.units; }
    return total;
  }
}

export function weeklyWindow(now: number, resetAt: number | null): { start: number; end: number | null } {
  if (resetAt === null) return { start: now - WEEK_MS, end: null };
  let end = resetAt + Math.ceil((now - resetAt) / WEEK_MS) * WEEK_MS;
  if (end <= now) end += WEEK_MS;
  return { start: end - WEEK_MS, end };
}
// A five-hour window opens with the first reply after the previous window closed.
export function fiveHourWindow(times: readonly number[], now: number, knownResetAt: number | null): { start: number; end: number } | null {
  if (knownResetAt !== null && knownResetAt > now && knownResetAt - FIVE_HOURS_MS <= now) return { start: knownResetAt - FIVE_HOURS_MS, end: knownResetAt };
  let start: number | null = null;
  let end = 0;
  for (const at of times) {
    if (at > now) break;
    if (knownResetAt !== null && at < knownResetAt) continue;
    if (start === null || at >= end) { start = Math.floor(at / 60000) * 60000; end = start + FIVE_HOURS_MS; }
  }
  return start !== null && now < end ? { start, end } : null;
}
function capacity(units: number, percent: number | null, previous: number | null): number | null {
  if (percent === null || units <= 0) return previous;
  if (percent >= MIN_ANCHOR_PERCENT || (previous === null && percent >= 1)) return units / (percent / 100);
  return previous;
}
export function calibrate(reading: ClaudeReading, at: number, scanner: ClaudeLogScanner, previous: ClaudeCalibration | null, source: ClaudeCalibration['source']): ClaudeCalibration {
  const weeklyResetAt = reading.weeklyResetAt ?? previous?.weeklyResetAt ?? null;
  const week = weeklyWindow(at, weeklyResetAt);
  const five = fiveHourWindow(scanner.timeline().map(event => event.at), at, reading.fiveHourResetAt);
  return {
    weeklyCapacity: capacity(scanner.units(week.start, at), reading.weeklyPercent, previous?.weeklyCapacity ?? null),
    fiveHourCapacity: capacity(five ? scanner.units(five.start, at) : 0, reading.fiveHourPercent, previous?.fiveHourCapacity ?? null),
    weeklyResetAt, fiveHourResetAt: reading.fiveHourResetAt ?? previous?.fiveHourResetAt ?? null, anchoredAt: at, source, weighting: WEIGHTING };
}
export function estimate(calibration: ClaudeCalibration, scanner: ClaudeLogScanner, now: number): { weekly: ClaudeWindowView; fiveHour: ClaudeWindowView } {
  const week = weeklyWindow(now, calibration.weeklyResetAt);
  const five = fiveHourWindow(scanner.timeline().map(event => event.at), now, calibration.fiveHourResetAt);
  const percent = (units: number, capacity: number | null) => capacity ? Math.round(units / capacity * 1000) / 10 : null;
  return {
    weekly: { percent: percent(scanner.units(week.start, now), calibration.weeklyCapacity), resetsAt: week.end === null ? null : Math.floor(week.end / 1000) },
    // No reply since the last window closed means nothing counts against a five-hour window yet.
    fiveHour: { percent: five ? percent(scanner.units(five.start, now), calibration.fiveHourCapacity) : calibration.fiveHourCapacity ? 0 : null,
      resetsAt: five ? Math.floor(five.end / 1000) : null } };
}
export function parseCalibration(value: unknown): ClaudeCalibration | null {
  if (!record(value)) return null;
  const amount = (item: unknown) => item === null || item === undefined ? null : typeof item === 'number' && Number.isFinite(item) && item > 0 && item < 1e7 ? item : undefined;
  const instant = (item: unknown) => item === null || item === undefined ? null : typeof item === 'number' && Number.isInteger(item) && item > 1.6e12 && item < 4.1e12 ? item : undefined;
  const result = { weeklyCapacity: amount(value.weeklyCapacity), fiveHourCapacity: amount(value.fiveHourCapacity),
    weeklyResetAt: instant(value.weeklyResetAt), fiveHourResetAt: instant(value.fiveHourResetAt), anchoredAt: instant(value.anchoredAt),
    source: value.source === 'manual' || value.source === 'status-line' ? value.source : undefined, weighting: value.weighting === WEIGHTING ? WEIGHTING : undefined };
  // A calibration from an older counting method is discarded so its capacity is never mixed with new units.
  if (Object.values(result).some(item => item === undefined) || result.anchoredAt === null) return null;
  return result as ClaudeCalibration;
}
// Accepts what the Claude app usage card shows: "Resets in 12h 32m", "2d 4h" or "45m".
export function parseResetsIn(text: string, now: number, maxMs: number): number | null {
  const trimmed = text.trim().toLowerCase().replace(/^resets\s+in\s+/, '');
  if (!trimmed) return null;
  const match = /^(?:(\d{1,2})\s*d)?\s*(?:(\d{1,3})\s*h)?\s*(?:(\d{1,4})\s*m(?:in)?)?$/.exec(trimmed);
  if (!match || !(match[1] || match[2] || match[3])) throw new Error('Reset time not understood');
  const ms = (Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60) * 1000;
  if (ms <= 0 || ms > maxMs) throw new Error('Reset time out of range');
  return Math.round((now + ms) / 60000) * 60000;
}
export function parseReadingInput(value: unknown, now: number): ClaudeReading {
  if (!record(value)) throw new Error('Reading missing');
  const text = (item: unknown) => typeof item === 'string' && item.length <= 40 ? item : item === undefined || item === null ? '' : null;
  const fields = ['weeklyPercent', 'weeklyResetsIn', 'fiveHourPercent', 'fiveHourResetsIn'].map(key => text(value[key]));
  if (fields.some(item => item === null)) throw new Error('Reading malformed');
  const [weekly, weeklyReset, five, fiveReset] = fields as string[];
  const percent = (item: string, required: boolean) => {
    if (!item.trim()) { if (required) throw new Error('Weekly percent required'); return null; }
    const number = Number(item.trim().replace(/%$/, ''));
    if (!Number.isFinite(number) || number < 0 || number > 100) throw new Error('Percent out of range');
    return number;
  };
  return { weeklyPercent: percent(weekly, true), weeklyResetAt: parseResetsIn(weeklyReset, now, WEEK_MS),
    fiveHourPercent: percent(five, false), fiveHourResetAt: parseResetsIn(fiveReset, now, FIVE_HOURS_MS) };
}

type Clock = () => { wall: number; mono: number };
export class ClaudeEstimator {
  private readonly scanner: ClaudeLogScanner;
  private scanning: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private scannedMono: number | null = null;
  private available = true;
  private stopped = true;
  private lastExactObservedAt = 0;
  constructor(private readonly changed: () => void, private readonly persist: (calibration: ClaudeCalibration) => void,
    private calibration: ClaudeCalibration | null, root = claudeProjectsRoot(), private readonly clock: Clock = () => ({ wall: Date.now(), mono: performance.now() })) {
    this.scanner = new ClaudeLogScanner(root);
  }
  start(): void { this.stopped = false; void this.refresh(); }
  // Scheduled scans run every 15 minutes; Refresh, readings and exact samples rescan sooner.
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.scanning) return this.scanning;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh(); }, SCAN_INTERVAL_MS);
    this.scanning = this.scanner.scan(this.clock().wall)
      .then(() => { this.available = true; this.scannedMono = this.clock().mono; })
      .catch(() => { this.available = false; })
      .finally(() => { this.scanning = null; if (!this.stopped) this.changed(); });
    this.changed();
    return this.scanning;
  }
  projects(from: number, to: number, roots: ProjectRoots): ProjectTotal[] { return this.scanner.byProject(from, to, roots); }
  get coverage(): { files: number; replies: number } { return { files: this.scanner.files, replies: this.scanner.replies }; }
  async calibrate(reading: ClaudeReading, source: ClaudeCalibration['source'] = 'manual', at = this.clock().wall): Promise<void> {
    await this.refresh();
    if (!this.available) throw new Error('Claude Code logs unavailable');
    this.calibration = calibrate(reading, at, this.scanner, this.calibration, source);
    this.persist(this.calibration);
    this.changed();
  }
  // An exact terminal sample re-anchors the estimate so drift from untracked use is corrected.
  async observeExact(sample: ClaudeSample): Promise<void> {
    if (this.stopped || sample.observedAt <= this.lastExactObservedAt || (!sample.sevenDay && !sample.fiveHour)) return;
    this.lastExactObservedAt = sample.observedAt;
    await this.calibrate({ weeklyPercent: sample.sevenDay?.usedPercent ?? null, weeklyResetAt: sample.sevenDay ? sample.sevenDay.resetsAt * 1000 : null,
      fiveHourPercent: sample.fiveHour?.usedPercent ?? null, fiveHourResetAt: sample.fiveHour ? sample.fiveHour.resetsAt * 1000 : null }, 'status-line', sample.observedAt).catch(() => undefined);
  }
  view(exact: ClaudeState, feed: ClaudeView['exact'] = exact.sample ? { source: 'status-line', host: null } : null): ClaudeView {
    const { wall, mono } = this.clock();
    const coverage = { files: this.scanner.files, replies: this.scanner.replies, unknownModels: this.scanner.unknownModels };
    const anchor = this.calibration ? { at: this.calibration.anchoredAt, source: this.calibration.source } : null;
    const base = { anchor, coverage, refreshing: !!this.scanning, exact: null };
    if (exact.status === 'ready' && exact.sample && (exact.sample.sevenDay || exact.sample.fiveHour)) {
      const window = (item: ClaudeSample['sevenDay']) => ({ percent: item?.usedPercent ?? null, resetsAt: item?.resetsAt ?? null });
      return { ...base, exact: feed, mode: 'exact', weekly: window(exact.sample.sevenDay), fiveHour: window(exact.sample.fiveHour), ageMs: exact.ageMs };
    }
    const empty = { percent: null, resetsAt: null };
    const ageMs = this.scannedMono === null ? null : Math.max(0, mono - this.scannedMono);
    if (!this.available) return { ...base, mode: 'unavailable', weekly: empty, fiveHour: empty, ageMs };
    if (this.scannedMono === null) return { ...base, mode: 'scanning', weekly: empty, fiveHour: empty, ageMs };
    if (!this.calibration || (!this.calibration.weeklyCapacity && !this.calibration.fiveHourCapacity)) return { ...base, mode: 'uncalibrated', weekly: empty, fiveHour: empty, ageMs };
    return { ...base, mode: 'estimate', ...estimate(this.calibration, this.scanner, wall), ageMs };
  }
  stop(): void { this.stopped = true; clearTimeout(this.timer); }
}
