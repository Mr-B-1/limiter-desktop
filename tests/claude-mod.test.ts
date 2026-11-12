import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeModReader, FRESH_MS, defaultModFile, newestExact, parseModSnapshot, readModFile } from '../src/providers/claude-mod.js';

const now = Date.UTC(2026, 9, 9, 20);
const resets = new Date(now + 3 * 3600000).toISOString();
const good = { schemaVersion: 1, source: 'claude-code-mod', host: 'MY-PC', observedAt: now - 60000,
  rateLimits: [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: resets }, { kind: 'seven_day', percentUsed: 84, resetsAt: resets }, { kind: 'spend_limit', percentUsed: 140 }] };
async function withDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-mod-'));
  try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('mod snapshot keeps only the two plan windows and rejects anything malformed', () => {
  const parsed = parseModSnapshot(good, now);
  assert.equal(parsed?.host, 'MY-PC');
  assert.equal(parsed?.sample.fiveHour?.usedPercent, 12.5); assert.equal(parsed?.sample.sevenDay?.usedPercent, 84);
  assert.equal(parsed?.sample.sevenDay?.resetsAt, Math.floor(Date.parse(resets) / 1000));
  assert.doesNotMatch(JSON.stringify(parsed), /spend_limit|140/);
  for (const bad of [{ ...good, schemaVersion: 2 }, { ...good, source: 'other' }, { ...good, host: '' }, { ...good, observedAt: now + 600000 }, { ...good, observedAt: now - 31 * 86400000 },
    { ...good, rateLimits: [] }, { ...good, rateLimits: [{ kind: 'seven_day', percentUsed: 101, resetsAt: resets }] }, { ...good, rateLimits: [{ kind: 'seven_day', percentUsed: 5 }] },
    { ...good, rateLimits: [{ kind: 'seven_day', percentUsed: 5, resetsAt: 'soon' }] }, { ...good, rateLimits: 'many' }, 'text', null])
    assert.equal(parseModSnapshot(bad, now), null, JSON.stringify(bad).slice(0, 60));
  assert.equal(defaultModFile('C:/home'), path.join('C:/home', '.local', 'share', 'Limiter', 'claude-usage.json'));
});

test('mod file reader tolerates missing, torn and oversized files', async () => withDir(async directory => {
  const file = path.join(directory, 'claude-usage.json');
  assert.equal(await readModFile(file, now), null);
  await fs.writeFile(file, JSON.stringify(good).slice(0, 40));
  assert.equal(await readModFile(file, now), null);
  await fs.writeFile(file, JSON.stringify({ ...good, host: 'x'.repeat(64), padding: 'y'.repeat(20000) }));
  assert.equal(await readModFile(file, now), null);
  await fs.writeFile(file, JSON.stringify(good) + '\n');
  assert.equal((await readModFile(file, now))?.sample.sevenDay?.usedPercent, 84);
}));

test('mod reader takes the newest host, ignores older files, goes stale after 15 minutes and drops passed resets', async () => withDir(async directory => {
  let clock = now;
  const local = path.join(directory, 'local', 'claude-usage.json');
  const remote = path.join(directory, 'live', 'server-claude-usage.json');
  await fs.mkdir(path.dirname(local), { recursive: true }); await fs.mkdir(path.dirname(remote), { recursive: true });
  await fs.writeFile(local, JSON.stringify(good));
  await fs.writeFile(remote, JSON.stringify({ ...good, host: 'server', observedAt: now - 30000, rateLimits: [{ kind: 'seven_day', percentUsed: 86, resetsAt: resets }] }));
  const changes: number[] = [];
  const reader = new ClaudeModReader(() => changes.push(clock), [local, remote], () => clock);
  reader.start();
  try {
    await reader.refresh();
    assert.equal(reader.state().status, 'ready'); assert.equal(reader.state().host, 'server'); assert.equal(reader.state().sample?.sevenDay?.usedPercent, 86);
    assert.equal(reader.state().sample?.fiveHour, null);
    await fs.writeFile(local, JSON.stringify({ ...good, observedAt: now - 120000, rateLimits: [{ kind: 'seven_day', percentUsed: 50, resetsAt: resets }] }));
    await reader.refresh();
    assert.equal(reader.state().sample?.sevenDay?.usedPercent, 86, 'an older reading never replaces a newer one');
    assert.equal(changes.length, 1);
    clock = now + FRESH_MS + 1;
    assert.equal(reader.state().status, 'stale');
    clock = Date.parse(resets) + 1000;
    assert.equal(reader.state().sample?.sevenDay, null);
  } finally { reader.stop(); }
  assert.equal(reader.state().sample, null);
}));

test('the newest of the status-line pipe and the mod file wins', () => {
  const sample = (at: number, used: number) => ({ schemaVersion: 1 as const, observedAt: at, fiveHour: null, sevenDay: { usedPercent: used, resetsAt: Math.floor(now / 1000) + 3600 } });
  const pipe = { status: 'ready' as const, sample: sample(now - 1000, 70), ageMs: 1000 };
  const mod = { status: 'ready' as const, sample: sample(now, 72), ageMs: 0, host: 'MY-PC' };
  assert.deepEqual(newestExact(pipe, mod).source, 'mod'); assert.equal(newestExact(pipe, mod).host, 'MY-PC');
  assert.equal(newestExact({ ...pipe, sample: sample(now + 5000, 71) }, mod).source, 'status-line');
  const waiting = { status: 'waiting' as const, sample: null, ageMs: null };
  assert.equal(newestExact(waiting, { ...waiting, host: null }).source, null);
  assert.equal(newestExact({ status: 'unavailable', sample: null, ageMs: null }, { ...waiting, host: null }).state.status, 'unavailable');
});
