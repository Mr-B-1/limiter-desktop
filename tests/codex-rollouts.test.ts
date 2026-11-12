import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { CODEX_WEIGHTS, CodexRolloutReader, increment, weightedUnits } from '../src/providers/codex-rollouts.js';
import { CODEX_APP_LABEL, OUTSIDE_LABEL, defaultRoots } from '../src/shared/projects.js';

const roots = defaultRoots('C:\\Users\\user', 'C:\\Projects');
const base = Date.UTC(2026, 9, 20, 12);
const minute = 60000;
type Counts = [input: number, cached: number, output: number, reasoning: number, total: number];
// Synthetic rollout lines in the real shapes (outer session_meta with payload.cwd and ids; event_msg token_count with
// cumulative total_token_usage); every id is invented, only the numbers come from real sessions.
function usage([input, cached, output, reasoning, total]: Counts) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total };
}
function meta(id: string, cwd: string | null, at = base): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'session_meta', payload: { id, session_id: id, cwd, cli_version: '0.0.0-test', originator: 'test' } });
}
function turn(cwd: string, at = base): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'turn_context', payload: { cwd, model: 'gpt-test', summary: 'x' } });
}
function event(counts: Counts, at: number): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(counts), last_token_usage: usage(counts), model_context_window: 258400 }, rate_limits: null } });
}
function rollout(id: string, cwd: string | null, events: Counts[], start = base): string {
  return [meta(id, cwd, start), turn(cwd || 'C:\\x', start), ...events.map((counts, index) => event(counts, start + (index + 1) * minute))].join('\n') + '\n';
}
// Token counter sequences of a two-event session and a three-event session.
const TWO_EVENTS: Counts[] = [[29884, 6144, 68, 50, 29952], [63751, 35840, 105, 69, 63856]];
const THREE_EVENTS: Counts[] = [[14227, 13056, 206, 143, 14433], [31235, 27136, 271, 143, 31506], [51174, 40192, 351, 157, 51525]];
// Ten events around a mid-session reset (drop at the sixth).
const RESET: Counts[] = [[73166412, 69417728, 288787, 122698, 73455199], [73349576, 69600256, 289777, 122931, 73639353], [73543353, 69783296, 290637, 123024, 73833990],
  [73738027, 69801728, 292334, 124058, 74030361], [73934543, 69995392, 292679, 124344, 74227222], [216565, 18304, 1221, 1025, 217786], [216565, 18304, 1221, 1025, 217786],
  [266049, 36608, 1620, 1046, 267669], [325424, 86016, 2112, 1112, 327536], [390988, 145280, 2542, 1236, 393530]];
const twoEventUnits = ((29884 - 6144) * 1.25 + 6144 * 0.125 + 68 * 10 + (33867 - 29696) * 1.25 + 29696 * 0.125 + 37 * 10) / 1e6;

async function withRoot(run: (root: string, reader: CodexRolloutReader) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-codex-rollouts-'));
  try { await run(root, new CodexRolloutReader(root)); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function write(root: string, name: string, text: string | Buffer, mtime?: number): Promise<string> {
  const file = path.join(root, '2026', '10', '20', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  if (mtime !== undefined) await fs.utimes(file, new Date(mtime), new Date(mtime));
  return file;
}
const tokensOf = (reader: CodexRolloutReader, from = base - minute, to = base + 1000 * minute) => reader.byProject(from, to, roots).map(row => [row.name, row.tokens, Math.round(row.units * 1e6)]);

test('increments and weights: counters themselves after a reset, per-class growth otherwise, cached inside input and reasoning inside output', () => {
  assert.deepEqual(increment(null, { input: 10, cached: 4, output: 2, total: 12 }), { input: 10, cached: 4, output: 2, total: 12 });
  assert.deepEqual(increment({ input: 10, cached: 4, output: 2, total: 12 }, { input: 25, cached: 9, output: 5, total: 30 }), { input: 15, cached: 5, output: 3, total: 18 });
  assert.deepEqual(increment({ input: 10, cached: 4, output: 2, total: 12 }, { input: 3, cached: 1, output: 1, total: 4 }), { input: 3, cached: 1, output: 1, total: 4 });
  // A class counter that falls while the total rises is clamped, never negative.
  assert.deepEqual(increment({ input: 1000, cached: 500, output: 100, total: 1100 }, { input: 1500, cached: 400, output: 90, total: 1590 }), { input: 500, cached: 0, output: 0, total: 490 });
  assert.equal(weightedUnits({ input: 1000000, cached: 400000, output: 100000, total: 1100000 }), 1.8);
  assert.deepEqual(CODEX_WEIGHTS, { uncachedInput: 1.25, cachedInput: 0.125, output: 10 });
});

test('a plain rollout counts its session once per project with per-event increments at their own times', async () => withRoot(async (root, reader) => {
  await write(root, 'two.jsonl', rollout('s-two', 'C:\\Projects\\Alpha', TWO_EVENTS));
  await write(root, 'docs.jsonl', rollout('s-three', 'C:\\Users\\user\\Documents\\Codex\\2026-01-01\\thread', THREE_EVENTS));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader), [['Alpha', 63856, Math.round(twoEventUnits * 1e6)], [CODEX_APP_LABEL, 51525, Math.round(((14227 - 13056) * 1.25 + 13056 * 0.125 + 206 * 10 + (17008 - 14080) * 1.25 + 14080 * 0.125 + 65 * 10 + (19939 - 13056) * 1.25 + 13056 * 0.125 + 80 * 10) / 1e6 * 1e6)]]);
  // A window that opens after the first event excludes that event's increment, not the whole session.
  assert.deepEqual(tokensOf(reader, base + minute + 1, base + 1000 * minute).find(row => row[0] === 'Alpha'), ['Alpha', 63856 - 29952, Math.round(((33867 - 29696) * 1.25 + 29696 * 0.125 + 37 * 10) / 1e6 * 1e6)]);
  assert.deepEqual(reader.coverage(), { files: 2, read: 2, skipped: 0, unreadable: 0, withoutTokens: 0, malformedLines: 0, sessions: 2 });
  assert.deepEqual(reader.counts, { offsetReads: 0, fullReads: 2, decompressions: 0 });
}));

test('a mid-session reset counts both runs and a repeated total adds nothing', async () => withRoot(async (root, reader) => {
  await write(root, 'reset.jsonl', rollout('s-reset', 'C:\\Projects', RESET));
  await reader.scan(base + 20 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['workspace root', 74227222 + 393530]]);
  const events = reader.events(base - minute, base + 1000 * minute);
  assert.equal(events.length, 9);
  assert.equal(events[5].tokens, 217786);
}));

test('a compressed copy of the same session counts once and the newest file owns it', async () => withRoot(async (root, reader) => {
  const plain = await write(root, 'same.jsonl', rollout('s-same', 'C:\\Projects\\Beta', TWO_EVENTS), base);
  await write(root, 'same.jsonl.zst', zlib.zstdCompressSync(Buffer.from(rollout('s-same', 'C:\\Projects\\Beta', [...TWO_EVENTS, [70000, 36000, 200, 100, 70200]]))), base + minute);
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Beta', 70200]]);
  assert.equal(reader.coverage().sessions, 1);
  assert.equal(reader.coverage().files, 2);
  assert.equal(reader.counts.decompressions, 1);
  // The plain file touched later becomes the owner again.
  await fs.utimes(plain, new Date(base + 2 * minute), new Date(base + 2 * minute));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Beta', 63856]]);
  assert.equal(reader.counts.decompressions, 1);
}));

test('growth is read by offset; replacement, shrink and older mtime are reread; a removed file drops out', async () => withRoot(async (root, reader) => {
  const file = await write(root, 'live.jsonl', rollout('s-live', 'C:\\Projects\\Gamma', [TWO_EVENTS[0]]), base);
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Gamma', 29952]]);
  await fs.appendFile(file, event(TWO_EVENTS[1], base + 2 * minute) + '\n');
  await fs.utimes(file, new Date(base + 2 * minute), new Date(base + 2 * minute));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Gamma', 63856]]);
  assert.deepEqual(reader.counts, { offsetReads: 1, fullReads: 1, decompressions: 0 });
  // Same byte length, different numbers, newer mtime: the file is reread from the start.
  const replaced = rollout('s-live', 'C:\\Projects\\Gamma', [TWO_EVENTS[0], [63751, 35840, 106, 69, 63857]]);
  assert.equal(Buffer.byteLength(replaced), (await fs.stat(file)).size);
  await fs.writeFile(file, replaced);
  await fs.utimes(file, new Date(base + 3 * minute), new Date(base + 3 * minute));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Gamma', 63857]]);
  assert.equal(reader.counts.fullReads, 2);
  // Unchanged identity: no read at all.
  await reader.scan(base + 11 * minute);
  assert.deepEqual(reader.counts, { offsetReads: 1, fullReads: 2, decompressions: 0 });
  // Shrink: the old contributions go away.
  await fs.writeFile(file, rollout('s-live', 'C:\\Projects\\Gamma', [TWO_EVENTS[0]]));
  await fs.utimes(file, new Date(base + 4 * minute), new Date(base + 4 * minute));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Gamma', 29952]]);
  // Older mtime than last seen (a restored backup) is reread too.
  await fs.writeFile(file, rollout('s-live', 'C:\\Projects\\Gamma', TWO_EVENTS));
  await fs.utimes(file, new Date(base + 1 * minute), new Date(base + 1 * minute));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Gamma', 63856]]);
  await fs.rm(file);
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader), []);
  assert.equal(reader.coverage().files, 0);
}));

test('a pending tail waits for its newline, a malformed completed line is counted and the rest of the file still counts', async () => withRoot(async (root, reader) => {
  const line = event(TWO_EVENTS[0], base + minute);
  const file = await write(root, 'tail.jsonl', meta('s-tail', 'C:\\Projects\\Beta') + '\n' + line.slice(0, 40), base);
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader), []);
  assert.deepEqual(reader.coverage(), { files: 1, read: 1, skipped: 0, unreadable: 0, withoutTokens: 1, malformedLines: 0, sessions: 1 });
  await fs.appendFile(file, line.slice(40) + '\n' + '{"broken":\n' + event(TWO_EVENTS[1], base + 2 * minute) + '\n');
  await fs.utimes(file, new Date(base + 2 * minute), new Date(base + 2 * minute));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Beta', 63856]]);
  assert.deepEqual(reader.coverage(), { files: 1, read: 1, skipped: 0, unreadable: 0, withoutTokens: 0, malformedLines: 1, sessions: 1 });
}));

test('garbage files are skipped, a session without totals is counted, and events before any session record stay outside', async () => withRoot(async (root, reader) => {
  await write(root, 'garbage.jsonl', Buffer.concat([Buffer.from([0, 255, 1, 2, 3, 200, 7, 9]), Buffer.from('\n')]));
  await write(root, 'garbage.jsonl.zst', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  await write(root, 'empty.jsonl', rollout('s-empty', 'C:\\Projects\\Empty', []));
  await write(root, 'orphan.jsonl', event(TWO_EVENTS[0], base + minute) + '\n');
  await reader.scan(base + 10 * minute);
  assert.deepEqual(reader.coverage(), { files: 4, read: 2, skipped: 2, unreadable: 0, withoutTokens: 1, malformedLines: 1, sessions: 2 });
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [[OUTSIDE_LABEL, 29952]]);
  await assert.rejects(new CodexRolloutReader(path.join(root, 'missing')).scan(base));
}));
