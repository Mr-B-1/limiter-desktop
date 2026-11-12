import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeEstimator, ClaudeLogScanner, FIVE_HOURS_MS, WEEK_MS, calibrate, claudeProjectsRoot, estimate, fiveHourWindow, parseCalibration,
  parseLogLine, parseReadingInput, parseResetsIn, usageUnits, weeklyWindow, type ClaudeCalibration } from '../src/providers/claude-local.js';

const hour = 3600000;
function reply(id: string, at: number, model = 'claude-opus-5-5', usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 1000 }, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'assistant', requestId: 'req-' + id, timestamp: new Date(at).toISOString(),
    message: { id: 'msg-' + id, model, content: [{ type: 'text', text: 'private transcript text' }], usage }, ...extra });
}
async function withLogs(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-claude-logs-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('usage units follow list prices, cache tiers and fast mode, and flag unknown models', () => {
  assert.equal(usageUnits('claude-opus-5-5', { input_tokens: 1e6 }).units, 4);
  assert.equal(usageUnits('claude-opus-5-5', { output_tokens: 1e6 }).units, 20);
  // Cache reads are excluded, matching the API rule that they do not count toward input rate limits.
  assert.equal(usageUnits('claude-opus-5-5', { cache_read_input_tokens: 1e6 }).units, 0);
  assert.equal(usageUnits('claude-fable-5-1', { cache_read_input_tokens: 1e6, input_tokens: 1e6 }).units, 10);
  assert.equal(usageUnits('claude-opus-5-5', { cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 }, cache_creation_input_tokens: 2e6 }).units, 13);
  assert.equal(usageUnits('claude-opus-5-5', { cache_creation_input_tokens: 1e6 }).units, 5);
  assert.equal(usageUnits('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }).units, 40);
  assert.equal(usageUnits('claude-haiku-4-5-20251001', { input_tokens: 1e6 }).units, 1);
  assert.deepEqual(usageUnits('claude-opus-9', { input_tokens: 1e6 }), { units: 4, known: false });
  assert.equal(usageUnits('claude-opus-5-5', { input_tokens: -5, output_tokens: 'many' }).units, 0);
});

test('log lines yield only usage metadata, keyed by reply, and skip synthetic or malformed lines', () => {
  const parsed = parseLogLine(reply('a', Date.UTC(2026, 9, 9, 12)));
  assert.equal(parsed?.key, 'msg-a:req-a'); assert.equal(parsed?.event.at, Date.UTC(2026, 9, 9, 12));
  assert.doesNotMatch(JSON.stringify(parsed), /private|transcript/);
  assert.equal(parseLogLine(reply('b', Date.now(), '<synthetic>')), null);
  assert.equal(parseLogLine(JSON.stringify({ type: 'user', message: { usage: {} } })), null);
  assert.equal(parseLogLine(reply('c', Date.now()).replace(/"timestamp":"[^"]+"/, '"timestamp":"soon"')), null);
  assert.equal(parseLogLine('{"type":"assistant"'), null);
});

test('scanner reads appended bytes once, joins split lines, dedupes repeated blocks and ignores old files', async () => withLogs(async root => {
  const now = Date.UTC(2026, 9, 9, 15);
  const nested = path.join(root, 'C--Projects', 'session', 'subagents');
  await fs.mkdir(nested, { recursive: true });
  const main = path.join(root, 'C--Projects', 'session.jsonl');
  const first = reply('1', now - hour);
  // A streaming reply is written several times; early lines carry a partial output count, the last the final one.
  const partial = reply('1', now - hour - 5000, 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 4 });
  await fs.writeFile(main, partial + '\n' + partial + '\n' + first + '\n' + JSON.stringify({ type: 'user', message: { content: 'x'.repeat(200) } }) + '\n');
  await fs.writeFile(path.join(nested, 'agent.jsonl'), reply('2', now - 2 * hour, 'claude-fable-5-1') + '\n' + first + '\n');
  const old = path.join(root, 'C--Projects', 'old.jsonl');
  await fs.writeFile(old, reply('old', now - 2 * hour) + '\n');
  await fs.utimes(old, new Date(now - 30 * 86400000), new Date(now - 30 * 86400000));
  const scanner = new ClaudeLogScanner(root);
  await scanner.scan(now);
  assert.equal(scanner.replies, 2); assert.equal(scanner.files, 2);
  const second = reply('3', now - 10 * 60000);
  await fs.appendFile(main, second.slice(0, 50));
  await scanner.scan(now);
  assert.equal(scanner.replies, 2);
  await fs.appendFile(main, second.slice(50) + '\n');
  await scanner.scan(now);
  assert.equal(scanner.replies, 3);
  assert.equal(Math.round(scanner.units(now - 3 * hour, now) * 1e6), 24000 + 60000 + 24000);
  await fs.writeFile(main, partial + '\n');
  await scanner.scan(now);
  assert.equal(scanner.replies, 3);
  // A reread partial line never lowers the final count already kept.
  assert.equal(Math.round(scanner.units(now - 3 * hour, now) * 1e6), 24000 + 60000 + 24000);
  assert.equal(scanner.timeline()[1].at, now - hour - 5000);
}));

test('scanner drops replies older than the lookback and a missing root rejects', async () => withLogs(async root => {
  const now = Date.UTC(2026, 9, 9, 15);
  await fs.writeFile(path.join(root, 's.jsonl'), reply('fresh', now - hour) + '\n' + reply('stale', now - 9 * 86400000) + '\n');
  const scanner = new ClaudeLogScanner(root);
  await scanner.scan(now);
  assert.equal(scanner.replies, 1);
  await assert.rejects(new ClaudeLogScanner(path.join(root, 'missing')).scan(now));
  assert.equal(claudeProjectsRoot({}, 'C:/home'), path.join('C:/home', '.claude', 'projects'));
  // CLAUDE_CONFIG_DIR wins when absolute; the CI smoke relies on it. A relative value is ignored.
  assert.equal(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: 'D:/claude-sample' }, 'C:/home'), path.join('D:/claude-sample', 'projects'));
  assert.equal(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: 'relative' }, 'C:/home'), path.join('C:/home', '.claude', 'projects'));
}));

test('weekly window follows a known reset and falls back to a rolling week', () => {
  const reset = Date.UTC(2026, 9, 10, 3);
  assert.deepEqual(weeklyWindow(reset - hour, reset), { start: reset - WEEK_MS, end: reset });
  assert.deepEqual(weeklyWindow(reset + hour, reset), { start: reset, end: reset + WEEK_MS });
  assert.deepEqual(weeklyWindow(reset, reset), { start: reset, end: reset + WEEK_MS });
  assert.deepEqual(weeklyWindow(reset - 3 * WEEK_MS + hour, reset), { start: reset - 3 * WEEK_MS, end: reset - 2 * WEEK_MS });
  assert.deepEqual(weeklyWindow(reset, null), { start: reset - WEEK_MS, end: null });
});

test('five-hour window opens at the first reply after the previous one closed', () => {
  const base = Date.UTC(2026, 9, 9, 6, 10, 42);
  const times = [base, base + hour, base + 4.9 * hour, base + 5.5 * hour, base + 6 * hour];
  const opened = Math.floor((base + 5.5 * hour) / 60000) * 60000;
  assert.deepEqual(fiveHourWindow(times, base + 6 * hour, null), { start: opened, end: opened + FIVE_HOURS_MS });
  assert.equal(fiveHourWindow(times, base + 11 * hour, null), null);
  assert.deepEqual(fiveHourWindow(times, base + 2 * hour, null), { start: Math.floor(base / 60000) * 60000, end: Math.floor(base / 60000) * 60000 + FIVE_HOURS_MS });
  const known = base + 3 * hour;
  assert.deepEqual(fiveHourWindow(times, base + 2 * hour, known), { start: known - FIVE_HOURS_MS, end: known });
  assert.equal(fiveHourWindow([], base, null), null);
});

test('calibration scales capacity to a reading and later estimates track new replies', async () => withLogs(async root => {
  const anchor = Date.UTC(2026, 9, 9, 13, 33);
  const reset = Date.UTC(2026, 9, 10, 3);
  const lines = [reply('w1', reset - 6 * 86400000), reply('w2', anchor - 30 * 60000), reply('w3', anchor + 30 * 60000), reply('before', reset - 8 * 86400000)];
  await fs.writeFile(path.join(root, 's.jsonl'), lines.join('\n') + '\n');
  const scanner = new ClaudeLogScanner(root);
  await scanner.scan(anchor + hour);
  const calibration = calibrate({ weeklyPercent: 40, weeklyResetAt: reset, fiveHourPercent: 10, fiveHourResetAt: null }, anchor, scanner, null, 'manual');
  assert.equal(Math.round(calibration.weeklyCapacity! * 1e6), 120000);
  assert.equal(Math.round(calibration.fiveHourCapacity! * 1e6), 240000);
  const later = estimate(calibration, scanner, anchor + hour);
  assert.equal(later.weekly.percent, 60); assert.equal(later.weekly.resetsAt, reset / 1000);
  assert.equal(later.fiveHour.percent, 20);
  const coarse = calibrate({ weeklyPercent: 2, weeklyResetAt: null, fiveHourPercent: null, fiveHourResetAt: null }, anchor, scanner, calibration, 'status-line');
  assert.equal(coarse.weeklyCapacity, calibration.weeklyCapacity);
  assert.equal(coarse.weeklyResetAt, reset);
  assert.equal(estimate(calibration, scanner, anchor + 7 * hour).fiveHour.percent, 0);
}));

test('reading input accepts usage-card text and rejects anything else', () => {
  const now = Date.UTC(2026, 9, 9, 14, 28);
  assert.equal(parseResetsIn('Resets in 12h 32m', now, WEEK_MS), now + (12 * 60 + 32) * 60000);
  assert.equal(parseResetsIn('2d 4h', now, WEEK_MS), now + 52 * hour);
  assert.equal(parseResetsIn('45 min', now, FIVE_HOURS_MS), now + 45 * 60000);
  assert.equal(parseResetsIn('', now, WEEK_MS), null);
  for (const bad of ['soon', '6h', '-1h', '0m']) assert.throws(() => parseResetsIn(bad, now, FIVE_HOURS_MS));
  assert.deepEqual(parseReadingInput({ weeklyPercent: '80%', weeklyResetsIn: '12h 32m', fiveHourPercent: '', fiveHourResetsIn: '' }, now),
    { weeklyPercent: 80, weeklyResetAt: now + (12 * 60 + 32) * 60000, fiveHourPercent: null, fiveHourResetAt: null });
  for (const bad of [{ weeklyPercent: '' }, { weeklyPercent: '101' }, { weeklyPercent: 80 }, { weeklyPercent: 'x'.repeat(41) }, null])
    assert.throws(() => parseReadingInput(bad, now));
});

test('calibration records validate every field', () => {
  const valid: ClaudeCalibration = { weeklyCapacity: 1841.6, fiveHourCapacity: null, weeklyResetAt: 1791601200000, fiveHourResetAt: null, anchoredAt: 1791556380000, source: 'manual', weighting: 2 };
  assert.deepEqual(parseCalibration(valid), valid);
  const fromV030 = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'weighting'));
  for (const bad of [{ ...valid, weeklyCapacity: 0 }, { ...valid, weeklyResetAt: 12 }, { ...valid, source: 'api' }, { ...valid, anchoredAt: undefined }, { ...valid, weighting: 1 }, fromV030, []])
    assert.equal(parseCalibration(bad), null);
});

test('estimator shows exact terminal samples first, re-anchors from them, and never exposes transcript text', async () => withLogs(async root => {
  const wall = Date.UTC(2026, 9, 9, 14); const mono = 1000;
  await fs.writeFile(path.join(root, 's.jsonl'), reply('a', wall - hour) + '\n');
  const saved: { value: ClaudeCalibration | null } = { value: null };
  const estimator = new ClaudeEstimator(() => {}, value => { saved.value = value; }, null, root, () => ({ wall, mono }));
  const waiting = { status: 'waiting' as const, sample: null, ageMs: null };
  assert.equal(estimator.view(waiting).mode, 'scanning');
  estimator.start(); await estimator.refresh();
  assert.equal(estimator.view(waiting).mode, 'uncalibrated');
  await estimator.calibrate(parseReadingInput({ weeklyPercent: '50', weeklyResetsIn: '3d', fiveHourPercent: '', fiveHourResetsIn: '' }, wall));
  assert.equal(saved.value?.source, 'manual');
  const view = estimator.view(waiting);
  assert.equal(view.mode, 'estimate'); assert.equal(view.weekly.percent, 50); assert.equal(view.coverage.replies, 1);
  assert.doesNotMatch(JSON.stringify(view), /private|transcript|msg-|req-/);
  const resetsAt = Math.floor((wall + 2 * 86400000) / 1000);
  const sample = { schemaVersion: 1 as const, observedAt: wall, fiveHour: null, sevenDay: { usedPercent: 25, resetsAt } };
  assert.equal(estimator.view({ status: 'ready', sample, ageMs: 1000 }).weekly.percent, 25);
  assert.equal(estimator.view({ status: 'ready', sample, ageMs: 1000 }).mode, 'exact');
  await estimator.observeExact(sample);
  assert.equal(saved.value?.source, 'status-line'); assert.equal(saved.value?.weeklyResetAt, resetsAt * 1000);
  assert.equal(estimator.view({ status: 'stale', sample, ageMs: 20 * 60000 }).weekly.percent, 25);
  estimator.stop();
}));
