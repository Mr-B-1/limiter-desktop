import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { once } from 'node:events';
import { RpcClient, SourceError, record } from '../src/providers/protocol.js';

const fixture = path.resolve('tests/fixtures/fake-codex.mjs');
const create = (mode = 'normal', timeout = 1000) => new RpcClient(process.execPath, [fixture, mode], timeout);
test('read-only handshake, correlated reads, and owned child cleanup', async () => {
  const client = create();
  const pid = client.pid!;
  await client.initialize();
  const account = await client.request('account/read', { refreshToken: false });
  assert.ok(record(account));
  await client.request('account/rateLimits/read');
  await client.request('account/rateLimits/read');
  assert.equal(client.counts.quotaReads, 2);
  await client.close();
  assert.throws(() => process.kill(pid, 0));
});
test('outgoing methods and refreshToken mutations are denied', async () => {
  const client = create();
  try {
    await assert.rejects(client.request('turn/start'), { kind: 'compatibility' });
    await assert.rejects(client.request('account/read', { refreshToken: true }), { kind: 'compatibility' });
    assert.equal(client.counts.requests, 0);
  } finally { await client.close(); }
});
for (const [mode, kind] of [['timeout', 'timeout'], ['crash', 'unavailable'], ['malformed', 'compatibility'], ['oversize', 'compatibility'], ['wrong-id', 'compatibility'], ['offline', 'offline'], ['throttled', 'throttled']] as const) {
  test('controlled transport failure: ' + mode, async () => {
    const client = create(mode, 350);
    try {
      await client.initialize();
      await assert.rejects(client.request('account/read', { refreshToken: false }), (error: unknown) => error instanceof SourceError && error.kind === kind);
    } finally { await client.close(); }
  });
}
test('sparse notifications are hints, not replacement data', async () => {
  const client = create('sparse');
  const hint = once(client, 'hint');
  try {
    await client.initialize();
    const [method] = await hint;
    assert.equal(method, 'account/rateLimits/updated');
    assert.equal(client.counts.quotaReads, 0);
  } finally { await client.close(); }
});
test('unknown incoming methods close the unsafe connection', async () => {
  const client = create('unknown');
  const fault = once(client, 'fault');
  await client.initialize();
  const [error] = await fault;
  assert.equal(error.kind, 'compatibility');
  await client.close();
});
test('a signed-out fixture remains null and is not invented as 0%', async () => {
  const client = create('signed-out');
  try {
    await client.initialize();
    const response = await client.request('account/read', { refreshToken: false });
    assert.ok(record(response));
    assert.equal(response.account, null);
  } finally { await client.close(); }
});
test('known MCP notifications are discarded with no response or action', async () => {
  const client = create('ignored');
  try {
    await client.initialize();
    await client.request('account/read', { refreshToken: false });
    assert.equal(client.counts.ignored, 1);
    assert.equal(client.counts.requests, 2);
  } finally { await client.close(); }
});

test('abort during a pending native read promptly tears down the owned child', async () => {
  const controller = new AbortController();
  const client = new RpcClient(process.execPath, [fixture, 'timeout'], 15000, controller.signal);
  await client.initialize();
  const pending = assert.rejects(client.request('account/read', { refreshToken: false }), { kind: 'stopped' });
  const started = performance.now();
  controller.abort();
  await pending;
  await client.close();
  assert.ok(performance.now() - started < 2000);
});
