import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AntigravityProvider, parseAntigravity, readAntigravity, type AntigravityRead } from '../src/providers/antigravity.js';

// RetrieveUserQuotaSummary as Antigravity reported it on 2026-11-25 (fractions and reset times as observed at 10:38 PST).
const geminiWeekReset = '2026-12-01T21:24:35Z';
const gemini5hReset = '2026-11-25T20:58:20Z';
const bucketOf = (id: string, window: string, remainingFraction: unknown, resetTime: unknown) => ({ bucketId: id, displayName: window === 'weekly' ? 'Weekly Limit Remaining' : 'Five Hour Limit Remaining', window, remainingFraction, resetTime });
const reply = { response: {
  description: 'Within each group, models share a weekly limit and a 5-hour limit.',
  groups: [
    { displayName: 'Gemini Models', description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Orchestrator (Neon), Gemini 3.8 Flash',
      buckets: [bucketOf('gemini-weekly', 'weekly', 0.88471144, geminiWeekReset), bucketOf('gemini-5h', '5h', 0.8898287, gemini5hReset)] },
    { displayName: 'Claude and GPT models', description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
      buckets: [bucketOf('3p-weekly', 'weekly', 0.9167813, '2026-12-01T21:38:55Z'), bucketOf('3p-5h', '5h', 1, '2026-11-25T21:53:03Z')] },
  ] } };

test('Antigravity reads each group with its weekly and 5-hour buckets', () => {
  const snapshot = parseAntigravity(reply, 100);
  assert.deepEqual(snapshot.pools.map(pool => [pool.name, pool.weekly?.remainingPercent, pool.fiveHour?.remainingPercent, pool.models.length]),
    [['Gemini', 88.5, 89, 4], ['Claude, GPT', 91.7, 100, 3]]);
  assert.equal(snapshot.pools[0].weekly?.resetsAt, Math.floor(Date.parse(geminiWeekReset) / 1000));
  assert.equal(snapshot.pools[0].fiveHour?.resetsAt, Math.floor(Date.parse(gemini5hReset) / 1000));
  assert.ok(snapshot.pools[0].models.includes('Orchestrator (Neon)'));
  assert.equal(snapshot.observedAt, 100);
});
test('Antigravity keeps a missing fraction as null, preserves explicit zero, ignores unknown windows, and rejects invalid schemas', () => {
  const group = (buckets: unknown[], description?: unknown) => ({ response: { groups: [{ displayName: 'Gemini Models', description, buckets }] } });
  const mixed = parseAntigravity(group([bucketOf('w', 'weekly', undefined, geminiWeekReset), bucketOf('f', '5h', 0, gemini5hReset), bucketOf('m', 'monthly', 0.5, gemini5hReset)]));
  assert.deepEqual(mixed.pools, [{ name: 'Gemini', models: [], weekly: { remainingPercent: null, resetsAt: Math.floor(Date.parse(geminiWeekReset) / 1000) }, fiveHour: { remainingPercent: 0, resetsAt: Math.floor(Date.parse(gemini5hReset) / 1000) } }]);
  assert.equal(parseAntigravity(group([bucketOf('w', 'weekly', null, null)])).pools[0].fiveHour, null);
  assert.throws(() => parseAntigravity({}));
  assert.throws(() => parseAntigravity({ response: {} }));
  assert.throws(() => parseAntigravity({ userStatus: {} }));
  assert.throws(() => parseAntigravity(group([bucketOf('w', 'weekly', 1.5, null)])));
  assert.throws(() => parseAntigravity(group([bucketOf('w', 'weekly', -0.1, null)])));
  assert.throws(() => parseAntigravity(group([bucketOf('w', 'weekly', '0.5', null)])));
  assert.throws(() => parseAntigravity(group([bucketOf('w', 'weekly', 0.5, 'soon')])));
  assert.throws(() => parseAntigravity({ response: { groups: [{ displayName: '', buckets: [] }] } }));
});
test('Antigravity reader maps HTTP 401/403 to signed-out and HTTP 500 to compatibility', async () => {
  const daemon = await mkdtemp(path.join(os.tmpdir(), 'limiter-antigravity-http-'));
  let code = 401;
  const server = createServer((_request, response) => {
    response.statusCode = code;
    response.end('error body');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await writeFile(path.join(daemon, 'hub_' + port + '.json'), JSON.stringify({ httpPort: port, csrfToken: 'test-token' }));
    assert.deepEqual(await readAntigravity(daemon), { ok: false, status: 'signed-out' });
    code = 403;
    assert.deepEqual(await readAntigravity(daemon), { ok: false, status: 'signed-out' });
    code = 500;
    assert.deepEqual(await readAntigravity(daemon), { ok: false, status: 'compatibility' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(daemon, { recursive: true, force: true });
  }
});
test('Antigravity reader skips a dead hub file, sends the token only to its server, and reports a missing install', async () => {
  const daemon = await mkdtemp(path.join(os.tmpdir(), 'limiter-antigravity-'));
  let seen: { token: unknown; path: unknown } | null = null;
  const server = createServer((request, response) => {
    seen = { token: request.headers['x-codeium-csrf-token'], path: request.url };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const live = (server.address() as { port: number }).port;
    const dead = await new Promise<number>(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)); }); });
    await writeFile(path.join(daemon, 'hub_' + live + '.json'), JSON.stringify({ httpPort: live, csrfToken: 'test-token-live' }));
    await writeFile(path.join(daemon, 'hub_' + dead + '.json'), JSON.stringify({ httpPort: dead, csrfToken: 'test-token-dead' }));
    // The dead server's file is newer, so it is tried first and skipped.
    const older = new Date(Date.now() - 60000);
    await utimes(path.join(daemon, 'hub_' + live + '.json'), older, older);
    const result = await readAntigravity(daemon);
    assert.equal(result.ok, true);
    assert.deepEqual(seen, { token: 'test-token-live', path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary' });
    await rm(path.join(daemon, 'hub_' + live + '.json'));
    assert.deepEqual(await readAntigravity(daemon), { ok: false, status: 'closed' });
    assert.deepEqual(await readAntigravity(path.join(daemon, 'missing')), { ok: false, status: 'absent' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(daemon, { recursive: true, force: true });
  }
});
test('Antigravity keeps the last reading as stale when the app closes, and clears it on sign-out', async () => {
  let now = 100000;
  let result: AntigravityRead = { ok: true, body: reply };
  const provider = new AntigravityProvider(() => {}, async () => result, () => now);
  await provider.refresh();
  assert.equal(provider.state().status, 'ready');
  assert.equal(provider.state().stale, false);
  result = { ok: false, status: 'closed' };
  await provider.refresh();
  assert.equal(provider.state().status, 'closed');
  assert.equal(provider.state().stale, true);
  assert.equal(provider.state().snapshot?.pools[0].weekly?.remainingPercent, 88.5);
  result = { ok: true, body: { changed: true } };
  await provider.refresh();
  assert.equal(provider.state().status, 'compatibility');
  assert.ok(provider.state().snapshot);
  result = { ok: false, status: 'signed-out' };
  await provider.refresh();
  assert.equal(provider.state().snapshot, null);
  result = { ok: true, body: reply };
  await provider.refresh();
  now += 11 * 60000;
  assert.equal(provider.state().stale, true);
  await provider.stop();
  assert.equal(provider.state().snapshot, null);
});
