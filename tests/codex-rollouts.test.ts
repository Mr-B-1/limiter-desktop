import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { CODEX_WEIGHTS, CodexRolloutReader, codexRolloutRoots, codexSessionsRoot, increment, weightedUnits } from '../src/providers/codex-rollouts.js';
import { CODEX_APP_LABEL, OUTSIDE_LABEL, defaultRoots } from '../src/shared/projects.js';
import type { ProjectInputFile } from '../src/services/project-input.js';

const roots = defaultRoots('C:\\Users\\user', 'C:\\Projects');
const base = Date.UTC(2026, 9, 20, 12);
const minute = 60000;
type Counts = [input: number, cached: number, output: number, reasoning: number, total: number];
// Synthetic rollout lines in the real shapes (outer session_meta with payload.cwd and ids; event_msg token_count with
// cumulative total_token_usage); every id is invented, only the numbers come from real sessions.
function usage([input, cached, output, reasoning, total]: Counts) {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total };
}
function meta(id: string, cwd: string | null, at = base, forkedFrom?: string): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'session_meta', payload: { id, session_id: id, cwd, forked_from_id: forkedFrom, cli_version: '0.0.0-test', originator: 'test' } });
}
function turn(cwd: string, at = base, turnId?: string): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'turn_context', payload: { cwd, turn_id: turnId, model: 'gpt-test', summary: 'x' } });
}
function event(counts: Counts, at: number, last: Counts = counts): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(counts), last_token_usage: usage(last), model_context_window: 258400 }, rate_limits: null } });
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

test('overlapping plain and compressed copies count once without losing a longer history when a shorter copy is touched', async () => withRoot(async (root, reader) => {
  const plain = await write(root, 'same.jsonl', rollout('s-same', 'C:\\Projects\\Beta', TWO_EVENTS), base);
  await write(root, 'same.jsonl.zst', zlib.zstdCompressSync(Buffer.from(rollout('s-same', 'C:\\Projects\\Beta', [...TWO_EVENTS, [70000, 36000, 200, 100, 70200]]))), base + minute);
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Beta', 70200]]);
  assert.equal(reader.coverage().sessions, 1);
  assert.equal(reader.coverage().files, 2);
  assert.equal(reader.counts.decompressions, 1);
  // A filesystem touch is not evidence that the shorter history supersedes the longer one.
  await fs.utimes(plain, new Date(base + 2 * minute), new Date(base + 2 * minute));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Beta', 70200]]);
  assert.equal(reader.counts.decompressions, 1);
}));

test('overlapping partial copies merge counters before computing deltas and filtering the time window', async () => withRoot(async (root, reader) => {
  const first: Counts = [100, 20, 10, 5, 110], second: Counts = [200, 40, 20, 10, 220], third: Counts = [300, 60, 30, 15, 330];
  await write(root, 'beginning.jsonl', rollout('s-overlap', 'C:\\Projects\\Alpha', [first, second]), base + 5 * minute);
  await write(root, 'ending.jsonl.zst', zlib.zstdCompressSync(Buffer.from([
    meta('s-overlap', 'C:\\Projects\\Alpha'), event(second, base + 2 * minute), event(third, base + 3 * minute)
  ].join('\n') + '\n')), base);
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Alpha', 330]]);
  assert.equal(reader.events(base - minute, base + 10 * minute).length, 3);
  assert.deepEqual(tokensOf(reader, base + 2 * minute, base + 3 * minute).map(row => [row[0], row[1]]), [['Alpha', 110]]);
}));

test('each turn uses its valid absolute cwd and an invalid turn cwd falls back to session metadata', async () => withRoot(async (root, reader) => {
  const values = (value: number): Counts => [value, 0, 0, 0, value];
  await write(root, 'turns.jsonl', [
    meta('s-turns', 'C:\\Projects\\Alpha'), event(values(100), base + minute),
    turn('C:\\Projects\\Beta', base + 2 * minute), event(values(300), base + 2 * minute),
    turn('relative\\folder', base + 3 * minute), event(values(600), base + 3 * minute),
    turn('C:drive-relative', base + 4 * minute), event(values(1000), base + 4 * minute),
    turn('C:\\Projects\\Gamma', base + 5 * minute), event(values(1500), base + 5 * minute)
  ].join('\n') + '\n');
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Alpha', 800], ['Gamma', 500], ['Beta', 200]]);
}));

test('Codex path attribution normalizes extended Windows paths and dot segments while preserving path boundaries', async () => withRoot(async (root, reader) => {
  const values: Counts[] = [[100, 0, 0, 0, 100]];
  for (const [index, cwd] of [
    '\\\\?\\C:\\Projects\\Alpha\\..\\Beta\\src', 'c:/Projects/Beta/./docs',
    '\\\\?\\C:\\Projects2\\Beta', 'C:Projects\\Beta', 'not/a/path'
  ].entries()) await write(root, `path-${index}.jsonl`, [meta(`s-path-${index}`, cwd), event(values[0], base + minute)].join('\n') + '\n');
  await write(root, 'unc.jsonl', [meta('s-unc', '\\\\?\\UNC\\server\\share\\Projects\\Delta\\src'), event(values[0], base + minute)].join('\n') + '\n');
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [[OUTSIDE_LABEL, 400], ['Beta', 200]]);
  const unc = reader.byProject(base, base + 10 * minute, { workspace: '\\\\server\\share\\Projects', codexApp: 'C:\\Unused' });
  assert.equal(unc.find(row => row.name === 'Delta')?.tokens, 100);
  const extendedRoot = reader.byProject(base, base + 10 * minute, { workspace: '\\\\?\\C:\\Projects', codexApp: 'C:\\Unused' });
  assert.equal(extendedRoot.find(row => row.name === 'Beta')?.tokens, 200);
}));

test('an out-of-window baseline is retained across reset, repeat, and incremental reads', async () => withRoot(async (root, reader) => {
  const file = await write(root, 'baseline.jsonl', [
    meta('s-baseline', 'C:\\Projects\\Alpha'), event([1000, 500, 100, 50, 1100], base - 10 * minute),
    event([1100, 550, 110, 55, 1210], base + minute), event([1100, 550, 110, 55, 1210], base + 2 * minute)
  ].join('\n') + '\n', base);
  await reader.scan(base + 10 * minute);
  assert.equal(reader.events(base, base + 10 * minute).reduce((sum, item) => sum + item.tokens, 0), 110);
  await fs.appendFile(file, event([50, 20, 5, 1, 55], base + 3 * minute) + '\n');
  await reader.scan(base + 10 * minute);
  assert.equal(reader.events(base, base + 10 * minute).reduce((sum, item) => sum + item.tokens, 0), 165);
  assert.equal(reader.counts.offsetReads, 1);
}));

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const ONE: Counts = [100, 20, 10, 5, 110];
const TWO: Counts = [200, 40, 20, 10, 220];
const THREE: Counts = [300, 60, 30, 15, 330];

test('the filename owner retains fresh fork counters despite a foreign parent metadata record', async () => withRoot(async (root, reader) => {
  await write(root, `rollout-${PARENT_ID}.jsonl`, [
    meta(PARENT_ID, 'C:\\Projects\\Parent'), turn('C:\\Projects\\Parent', base, 'parent-turn'), event(ONE, base + minute)
  ].join('\n') + '\n');
  await write(root, `rollout-${CHILD_ID}.jsonl`, [
    meta(CHILD_ID, 'C:\\Projects\\Child', base, PARENT_ID), meta(PARENT_ID, 'C:\\Projects\\Parent'),
    turn('C:\\Projects\\Child', base, 'child-turn'), event(ONE, base + minute), event(TWO, base + 2 * minute, ONE)
  ].join('\n') + '\n');
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Child', 220], ['Parent', 110]]);
  assert.equal(reader.coverage().sessions, 2);
}));

test('a replayed fork prefix uses parent turn identity despite rewritten timestamps and retains the inherited baseline', async () => withRoot(async (root, reader) => {
  await write(root, `rollout-${PARENT_ID}.jsonl.zst`, zlib.zstdCompressSync(Buffer.from([
    meta(PARENT_ID, 'C:\\Projects\\Parent'), turn('C:\\Projects\\Parent', base, 'inherited-turn'),
    event(ONE, base - 3 * minute), event(TWO, base - 2 * minute, ONE), event(THREE, base - minute, ONE)
  ].join('\n') + '\n')), base - 20 * 86400000);
  await write(root, `rollout-${CHILD_ID}.jsonl`, [
    meta(CHILD_ID, 'C:\\Projects\\Child', base, PARENT_ID), turn('C:\\Projects\\Parent', base, 'inherited-turn'),
    event(TWO, base, ONE), event(THREE, base, ONE),
    turn('C:\\Projects\\Child', base, 'new-turn'), event([350, 70, 35, 17, 385], base, [50, 10, 5, 2, 55])
  ].join('\n') + '\n');
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader, base, base + minute).map(row => [row[0], row[1]]), [['Child', 55]]);
  assert.equal(reader.events(base - 10 * minute, base + minute).reduce((sum, item) => sum + item.tokens, 0), 385);
  assert.equal(reader.coverage().files, 2);
  assert.equal(reader.coverage().skipped, 0);
}));

test('unrelated lookalike events and fresh fork turns are not removed as copied history', async () => withRoot(async (root, reader) => {
  for (const [id, name] of [[PARENT_ID, 'Parent'], [CHILD_ID, 'Child'], ['independent', 'Independent']]) {
    await write(root, `rollout-${id}.jsonl`, [
      meta(id, `C:\\Projects\\${name}`, base, id === CHILD_ID ? PARENT_ID : undefined),
      turn(`C:\\Projects\\${name}`, base, `${name}-turn`), event(ONE, base + minute)
    ].join('\n') + '\n');
  }
  await reader.scan(base + 10 * minute);
  assert.equal(reader.events(base, base + 2 * minute).reduce((sum, item) => sum + item.tokens, 0), 330);
  assert.equal(reader.byProject(base, base + 2 * minute, roots).length, 3);
}));

test('a true counter reset can increase the total and repeated counters in its turn add nothing', async () => withRoot(async (root, reader) => {
  await write(root, 'rising-reset.jsonl', [
    meta('rising-reset', 'C:\\Projects\\Alpha'), turn('C:\\Projects\\Alpha', base, 'before-reset'), event(ONE, base + minute),
    turn('C:\\Projects\\Beta', base + 2 * minute, 'after-reset'), event(TWO, base + 2 * minute), event(TWO, base + 3 * minute)
  ].join('\n') + '\n');
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Beta', 220], ['Alpha', 110]]);
}));

test('unchanged counters after a new turn context remain repeats before the next increment', async () => withRoot(async (root, reader) => {
  await write(root, 'context-repeat.jsonl', [
    meta('context-repeat', 'C:\\Projects\\Alpha'), turn('C:\\Projects\\Alpha', base, 'first-turn'), event(ONE, base),
    turn('C:\\Projects\\Beta', base + minute, 'second-turn'), event(ONE, base + minute), event(TWO, base + 2 * minute, ONE)
  ].join('\n') + '\n');
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Alpha', 110], ['Beta', 110]]);
}));

test('a missing inherited baseline is degraded while later observed deltas remain available', async () => withRoot(async (root, reader) => {
  await write(root, `rollout-${CHILD_ID}.jsonl`, [
    meta(CHILD_ID, 'C:\\Projects\\Child', base, PARENT_ID), turn('C:\\Projects\\Child', base, 'unknown-prefix'),
    event(TWO, base, ONE), event(THREE, base + minute, ONE)
  ].join('\n') + '\n');
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Child', 110]]);
  assert.equal(reader.coverage().skipped, 1);
  assert.equal(reader.coverage().read, 0);
}));

test('a canonical owning filename wins divergent copies while matching prefixes can extend it', async () => withRoot(async (root, reader) => {
  await write(root, `rollout-${PARENT_ID}.jsonl`, rollout(PARENT_ID, 'C:\\Projects\\Alpha', [ONE, TWO]), base);
  await write(root, 'alias.jsonl', rollout(PARENT_ID, 'C:\\Projects\\Beta', [ONE, [900, 40, 20, 10, 920], [1000, 40, 20, 10, 1020]]), base + minute);
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Alpha', 220]]);
  assert.equal(reader.coverage().skipped, 1);
}));

test('a UUID filename with missing owner metadata keeps turn attribution without adopting a foreign owner', async () => withRoot(async (root, reader) => {
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await write(root, `rollout-${owner.toUpperCase()}.jsonl`, [
    meta(PARENT_ID, 'C:\\Projects\\Wrong'), turn('C:\\Projects\\Actual', base, 'actual-turn'), event(ONE, base + minute)
  ].join('\n') + '\n');
  await write(root, 'copy.jsonl.zst', zlib.zstdCompressSync(Buffer.from([
    meta(owner, 'C:\\Projects\\Actual'), turn('C:\\Projects\\Actual', base, 'actual-turn'), event(ONE, base + minute)
  ].join('\n') + '\n')));
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Actual', 110]]);
  assert.equal(reader.coverage().sessions, 1);
}));

test('a metadata-incomplete canonical copy uses captured same-owner lineage from a matching alias', async () => withRoot(async (root, reader) => {
  await write(root, `rollout-${PARENT_ID}.jsonl`, [
    meta(PARENT_ID, 'C:\\Projects\\Parent'), turn('C:\\Projects\\Parent', base - minute, 'shared-turn'), event(TWO, base - minute, ONE)
  ].join('\n') + '\n');
  const observations = [turn('C:\\Projects\\Parent', base, 'shared-turn'), event(TWO, base, ONE),
    turn('C:\\Projects\\Child', base, 'child-turn'), event(THREE, base, ONE)];
  await write(root, `rollout-${CHILD_ID}.jsonl`, [meta(PARENT_ID, 'C:\\Projects\\Parent'), ...observations].join('\n') + '\n');
  await write(root, 'alias.jsonl.zst', zlib.zstdCompressSync(Buffer.from([
    meta(CHILD_ID, 'C:\\Projects\\Child', base, PARENT_ID), ...observations
  ].join('\n') + '\n')));
  await reader.scan(base + minute);
  assert.deepEqual(tokensOf(reader, base, base + minute).map(row => [row[0], row[1]]), [['Child', 110]]);
  assert.equal(reader.coverage().skipped, 0);
}));

test('a fresh-looking fork with a missing ancestor is not certified, and cycles terminate with degraded coverage', async () => withRoot(async root => {
  const child = await write(root, `rollout-${CHILD_ID}.jsonl`, [
    meta(CHILD_ID, 'C:\\Projects\\Child', base, PARENT_ID), turn('C:\\Projects\\Child', base, 'copied-or-fresh'), event(ONE, base)
  ].join('\n') + '\n');
  const missing = new CodexRolloutReader(root);
  await missing.scan(base + minute);
  assert.equal(missing.events(base, base + minute).length, 0);
  assert.equal(missing.issues.unresolvedForks, 1);
  await assert.rejects(new CodexRolloutReader(root).scan(base + minute, []), /incomplete/);
  await write(root, `rollout-${PARENT_ID}.jsonl`, [
    meta(PARENT_ID, 'C:\\Projects\\Parent', base, CHILD_ID), turn('C:\\Projects\\Parent', base, 'parent-turn'), event(ONE, base)
  ].join('\n') + '\n');
  const cyclic = new CodexRolloutReader(root);
  await cyclic.scan(base + minute);
  assert.equal(cyclic.issues.lineageCycles, 2);
  assert.equal(cyclic.coverage().skipped, 2);
  assert.equal((await fs.stat(child)).isFile(), true);
}));

test('inherited signatures after fresh child usage are degraded and refused by strict audit', async () => withRoot(async (root, reader) => {
  await write(root, `rollout-${PARENT_ID}.jsonl`, [
    meta(PARENT_ID, 'C:\\Projects\\Parent'), turn('C:\\Projects\\Parent', base, 'inherited-turn'), event(ONE, base)
  ].join('\n') + '\n');
  await write(root, `rollout-${CHILD_ID}.jsonl`, [
    meta(CHILD_ID, 'C:\\Projects\\Child', base, PARENT_ID), turn('C:\\Projects\\Child', base, 'fresh-turn'), event(TWO, base),
    turn('C:\\Projects\\Parent', base + minute, 'inherited-turn'), event(ONE, base + minute)
  ].join('\n') + '\n');
  await reader.scan(base + 10 * minute);
  assert.equal(reader.issues.nonPrefixReplays, 1);
  assert.equal(reader.coverage().skipped, 1);
  await assert.rejects(new CodexRolloutReader(root).scan(base + 10 * minute, []), /incomplete/);
}));

test('POSIX root containment keeps case and normalizes dot segments', async () => withRoot(async (root, reader) => {
  for (const [index, cwd] of ['/projects/Alpha/../Beta', '/projects/beta', '/Projects/Beta', '/projects2/Beta'].entries()) {
    await write(root, `posix-${index}.jsonl`, [meta(`posix-${index}`, cwd), event(ONE, base)].join('\n') + '\n');
  }
  await reader.scan(base + minute);
  const totals = reader.byProject(base, base + minute, { workspace: '/projects', codexApp: '/home/example/Documents/Codex' });
  assert.deepEqual(totals.map(item => [item.name, item.tokens]), [[OUTSIDE_LABEL, 220], ['beta', 110], ['Beta', 110]]);
}));

test('custom absolute Codex home includes an optional archive and rejects drive-relative home overrides', async () => withRoot(async root => {
  const configured = codexRolloutRoots(root, path.join(root, 'custom-home'));
  assert.deepEqual(configured, [path.join(root, 'custom-home', 'sessions'), path.join(root, 'custom-home', 'archived_sessions')]);
  assert.equal(codexSessionsRoot(root, 'C:relative'), path.join(root, '.codex', 'sessions'));
  await write(configured[0], 'active.jsonl', rollout('active', 'C:\\Projects\\Alpha', [ONE]));
  const reader = new CodexRolloutReader(configured);
  await reader.scan(base + minute);
  assert.equal(reader.coverage().files, 1);
  await write(configured[1], 'archived.jsonl.zst', zlib.zstdCompressSync(Buffer.from(rollout('archived', 'C:\\Projects\\Beta', [ONE]))));
  await reader.scan(base + minute);
  assert.equal(reader.coverage().files, 2);
  assert.equal(reader.events(base, base + 2 * minute).reduce((sum, item) => sum + item.tokens, 0), 220);
}));

test('a recent suffix loads its older matching sibling from the archive before computing window deltas', async () => withRoot(async root => {
  const active = path.join(root, 'sessions'), archived = path.join(root, 'archived_sessions');
  await write(archived, `rollout-${PARENT_ID}.jsonl.zst`, zlib.zstdCompressSync(Buffer.from([
    meta(PARENT_ID, 'C:\\Projects\\Alpha'), event(ONE, base + minute), event(TWO, base + 2 * minute, ONE)
  ].join('\n') + '\n')), base - 20 * 86400000);
  await write(active, `rollout-${PARENT_ID}.jsonl`, [
    meta(PARENT_ID, 'C:\\Projects\\Alpha'), event(TWO, base + 2 * minute, ONE), event(THREE, base + 3 * minute, ONE)
  ].join('\n') + '\n');
  const reader = new CodexRolloutReader([active, archived]);
  await reader.scan(base + 10 * minute);
  assert.deepEqual(tokensOf(reader, base + 2 * minute, base + 3 * minute).map(row => [row[0], row[1]]), [['Alpha', 110]]);
  assert.equal(reader.coverage().files, 2);
  assert.equal(reader.coverage().sessions, 1);
}));

test('audit hashes exact plain and compressed inputs, includes the partial tail, and requires a fresh reader', async () => withRoot(async (root, reader) => {
  const plain = Buffer.from(rollout('proof-plain', 'C:\\Projects\\Alpha', [ONE]) + event(TWO, base + 2 * minute).slice(0, 60));
  const compressed = zlib.zstdCompressSync(Buffer.from(rollout('proof-compressed', 'C:\\Projects\\Beta', [THREE]).trimEnd()));
  await write(root, 'proof.jsonl', plain);
  await write(root, 'proof.jsonl.zst', compressed);
  const proof: ProjectInputFile[] = [];
  await reader.scan(base + 10 * minute, proof);
  assert.equal(proof.length, 2);
  for (const [bytes, encoding] of [[plain, 'plain'], [compressed, 'zstd']] as const) {
    const item = proof.find(item => item.encoding === encoding)!;
    assert.equal(item.byteLimit, bytes.length);
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.match(item.key, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(tokensOf(reader).map(row => [row[0], row[1]]), [['Beta', 330], ['Alpha', 110]]);
  await assert.rejects(reader.scan(base + 10 * minute, []), /fresh reader/);
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
