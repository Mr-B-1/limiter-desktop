import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { ClaudeProvider, claudePipe, parseClaudeSample, statusLineSample } from '../src/providers/claude.js';
const future = Math.floor(Date.now() / 1000) + 3600;
test('Claude allowlist drops all conversation, identity and token data', () => {
  const sample = statusLineSample({ session_id: 'private-fixture', transcript_path: '/private', cost: { total_cost_usd: 99 }, rate_limits: { seven_day: { used_percentage: 32.5, resets_at: future } } }, 100);
  assert.deepEqual(sample, { schemaVersion: 1, observedAt: 100, fiveHour: null, sevenDay: { usedPercent: 32.5, resetsAt: future } });
  assert.doesNotMatch(JSON.stringify(sample), /private|cost|session|token|transcript/);
});
test('Claude missing and malformed limits remain unknown, but zero is preserved', () => {
  assert.equal(statusLineSample({}).sevenDay, null);
  for (const percent of ['20', null, NaN, Infinity, -1, 100.1, 500]) assert.equal(statusLineSample({ rate_limits: { seven_day: { used_percentage: percent, resets_at: future } } }).sevenDay, null);
  assert.equal(statusLineSample({ rate_limits: { five_hour: { used_percentage: 0, resets_at: future } } }).fiveHour?.usedPercent, 0);
});
test('Claude rejects replayed, future, malformed pipe envelopes', () => {
  const sample = statusLineSample({}, 100000);
  assert.equal(parseClaudeSample(sample, 200000), null);
  assert.equal(parseClaudeSample(sample, 1), null);
  assert.equal(parseClaudeSample({ ...sample, observedAt: '100000' }), null);
});
test('real Claude named pipe clears expired and missing windows and does not retain data after stop', async () => {
  const pipe = claudePipe('test-' + process.pid + '-' + Date.now());
  let changed: (() => void) | null = null;
  let wall = Date.now(); let mono = 10000;
  const provider = new ClaudeProvider(() => changed?.(), pipe, () => ({wall,mono}));
  provider.start();
  const send = async (value: unknown) => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Pipe update timeout')), 2500);
      changed = () => { clearTimeout(timeout); resolve(); };
      const socket = createConnection(pipe); socket.on('error', reject);
      socket.on('connect', () => socket.end(JSON.stringify(value) + '\n'));
    });
  };
  try {
    assert.equal(provider.state().sample, null);
    await send(statusLineSample({ rate_limits: { seven_day: { used_percentage: 70, resets_at: future } } }));
    assert.equal(provider.state().sample?.sevenDay?.usedPercent, 70);
    wall -= 24 * 3600000; mono += 16 * 60000;
    assert.equal(provider.state().status, 'stale');
    wall = future * 1000 + 1;
    assert.equal(provider.state().sample?.sevenDay, null);
    wall = Date.now();
    await send(statusLineSample({}));
    assert.equal(provider.state().status, 'waiting'); assert.equal(provider.state().sample?.sevenDay, null);
  } finally { provider.stop(); }
  assert.equal(provider.state().sample, null);
});
test('Claude ignores late samples within one clock epoch and accepts a new sample after a clock rollback', async () => {
  let wall = Date.now(); let mono = 10000;
  const pipe = claudePipe('order-' + process.pid + '-' + wall);
  const provider = new ClaudeProvider(() => {}, pipe, () => ({ wall, mono })); provider.start();
  const send = (used: number, observedAt: number) => new Promise<void>((resolve, reject) => {
    const socket = createConnection(pipe); socket.on('error', reject); socket.on('close', () => resolve());
    socket.on('connect', () => socket.end(JSON.stringify(statusLineSample({ rate_limits: { seven_day: { used_percentage:used, resets_at:future } } }, observedAt)) + '\n'));
  });
  try {
    await send(80, wall); await send(20, wall - 1000);
    assert.equal(provider.state().sample?.sevenDay?.usedPercent, 80);
    wall -= 3600000; mono += 1000;
    assert.equal(provider.state().status, 'stale');
    await send(90, wall); assert.equal(provider.state().sample?.sevenDay?.usedPercent, 90);
    assert.equal(provider.state().status, 'ready');
  } finally { provider.stop(); }
});
