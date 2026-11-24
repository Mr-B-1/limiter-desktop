import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AntigravityProvider, parseAntigravity, readAntigravity, type AntigravityRead } from '../src/providers/antigravity.js';

// Model ids and labels as Antigravity 2.35.0 reported them on 2026-11-24; the account fields are placeholders that must be dropped.
const geminiReset = '2026-11-25T01:13:00Z';
const otherReset = '2026-11-25T01:27:10Z';
const gemini = ['gemini-4-neon-high', 'gemini-4-carbon-medium', 'gemini-4-argon-low', 'gemini-4-hydrogen-xhigh', 'gemini-3.8-flash-high'];
const models = [
  ...gemini.map(id => ({ modelId: id, label: 'Gemini ' + id, quotaInfo: { remainingFraction: 0.8616644, resetTime: geminiReset } })),
  { modelId: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', quotaInfo: { remainingFraction: 0.8616644, resetTime: '2026-11-25T01:13:40Z' } },
  { modelId: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', quotaInfo: { remainingFraction: 1, resetTime: otherReset } },
  { modelId: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)', quotaInfo: { remainingFraction: 1, resetTime: otherReset } },
  { modelId: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', quotaInfo: { remainingFraction: 1, resetTime: otherReset } },
  { modelId: 'chat-only', label: 'No quota model' },
];
const reply = { userStatus: { email: 'person@example.invalid', name: 'Placeholder Person', planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } }, cascadeModelConfigData: { clientModelConfigs: models } } };

test('Antigravity groups models by shared quota and names each pool by model family', () => {
  const snapshot = parseAntigravity(reply, 100);
  assert.equal(snapshot.plan, 'Pro');
  assert.deepEqual(snapshot.pools.map(pool => [pool.name, pool.remainingPercent, pool.models.length]), [['Gemini', 86.2, 6], ['Claude, GPT', 100, 3]]);
  assert.equal(snapshot.pools[0].resetsAt, Math.floor(Date.parse(geminiReset) / 1000));
  assert.ok(snapshot.pools[0].models.includes('Orchestrator (Neon)'));
  assert.doesNotMatch(JSON.stringify(snapshot), /example\.invalid|Placeholder|TEAMS_TIER/);
});
test('Antigravity keeps a missing fraction as null, preserves explicit zero, separates missing from zero, and rejects invalid schemas', () => {
  const mixed = parseAntigravity({
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          { modelId: 'gemini-a', label: 'Gemini A', quotaInfo: { resetTime: geminiReset } },
          { modelId: 'gemini-b', label: 'Gemini B', quotaInfo: { remainingFraction: null, resetTime: geminiReset } },
          { modelId: 'claude-z', label: 'Claude Z', quotaInfo: { remainingFraction: 0, resetTime: geminiReset } },
        ],
      },
    },
  });
  assert.equal(mixed.plan, null);
  assert.deepEqual(
    mixed.pools.map(pool => [pool.name, pool.remainingPercent, pool.models]),
    [
      ['Gemini', null, ['Gemini A', 'Gemini B']],
      ['Claude', 0, ['Claude Z']],
    ],
  );
  assert.throws(() => parseAntigravity({}));
  assert.throws(() => parseAntigravity({ userStatus: {} }));
  assert.throws(() => parseAntigravity({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'X', quotaInfo: { remainingFraction: 1.5 } }] } } }));
  assert.throws(() => parseAntigravity({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'X', quotaInfo: { remainingFraction: -0.1 } }] } } }));
  assert.throws(() => parseAntigravity({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'X', quotaInfo: { remainingFraction: '0.5' } }] } } }));
  assert.throws(() => parseAntigravity({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'X', quotaInfo: { resetTime: 'soon' } }] } } }));
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
    assert.deepEqual(seen, { token: 'test-token-live', path: '/exa.language_server_pb.LanguageServerService/GetUserStatus' });
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
  assert.equal(provider.state().snapshot?.pools[0].remainingPercent, 86.2);
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
