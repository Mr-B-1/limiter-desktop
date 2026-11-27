import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider, type SourceConnection } from '../src/providers/codex.js';
import { nativeExecutable } from '../src/providers/codex-discovery.js';
import type { RpcClient } from '../src/providers/protocol.js';
class FakeClient extends EventEmitter {
  alive = true; reads = 0; identity = 'a@example.invalid'; changeDuringRead = false; notifyDuringRead = false;
  counts = { quotaReads: 0 };
  async initialize(): Promise<void> {}
  async request(method: string): Promise<unknown> {
    if (method === 'account/read') return { account: { type: 'chatgpt', email: this.identity, planType: 'pro' } };
    this.counts.quotaReads++;
    this.reads++;
    if (this.changeDuringRead) this.identity = 'b@example.invalid';
    if (this.notifyDuringRead) this.emit('hint', 'account/updated');
    return { rateLimits: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2000000000 } } };
  }
  async close(): Promise<void> { this.alive = false; }
}
function connection(client: FakeClient): SourceConnection {
  return { candidate: { path: 'fixture', version: 'fixture', schemaHash: 'fixture', arch: 'arm64' }, client: client as unknown as RpcClient };
}
test('account context is checked before and after the quota read', async () => {
  const client = new FakeClient(); client.changeDuringRead = true;
  const provider = new CodexProvider(async () => connection(client));
  await assert.rejects(provider.read(), { kind: 'changed' });
  await provider.stop();
});
test('account notification during an in-flight read rejects that generation', async () => {
  const client = new FakeClient(); client.notifyDuringRead = true;
  const provider = new CodexProvider(async () => connection(client));
  await assert.rejects(provider.read(), { kind: 'changed' });
  await provider.stop();
});
test('the sanitized snapshot never contains the raw account identity', async () => {
  const client = new FakeClient();
  const provider = new CodexProvider(async () => connection(client));
  const snapshot = await provider.read();
  assert.equal(snapshot.scopeConfirmed, true);
  assert.equal(JSON.stringify(snapshot).includes(client.identity), false);
  await provider.stop();
});
test('reconnecting invalidates the old connection and creates a new generation', async () => {
  const first = new FakeClient(); const second = new FakeClient(); let calls = 0; let invalidations = 0;
  const provider = new CodexProvider(async () => connection(calls++ === 0 ? first : second));
  provider.on('invalidate', () => invalidations++);
  const a = await provider.read(); first.alive = false;
  const b = await provider.read();
  assert.ok(b.generation > a.generation); assert.equal(calls, 2); assert.ok(invalidations >= 2);
  await provider.stop();
});
test('sparse quota notification requests a full read without altering the old snapshot', async () => {
  const client = new FakeClient(); let hints = 0;
  const provider = new CodexProvider(async () => connection(client));
  provider.on('hint', () => hints++);
  const before = await provider.read(); client.emit('hint', 'account/rateLimits/updated');
  assert.equal(before.windows[0].usedPercent, 20); assert.equal(hints, 1);
  await provider.read(); assert.equal(client.counts.quotaReads, 2);
  await provider.stop();
});
test('stopping during connect closes the late child and rejects the pending read', async () => {
  const client = new FakeClient(); let resolve!: (connection: SourceConnection) => void;
  const provider = new CodexProvider(() => new Promise(done => { resolve = done; }));
  const pending = provider.read();
  const check = assert.rejects(pending, { kind: 'stopped' });
  await new Promise(done => setImmediate(done));
  const stop = provider.stop();
  resolve(connection(client));
  await stop; await check; assert.equal(client.alive, false);
});
test('nativeExecutable accepts x64 codex.exe on all Windows PCs and ARM64 codex.exe only on ARM64 PCs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-pe-'));
  const writePe = async (folder: string, name: string, machine: number) => {
    const sub = path.join(dir, folder);
    await fs.mkdir(sub, { recursive: true });
    const file = path.join(sub, name);
    const buf = Buffer.alloc(128);
    buf.write('MZ', 0, 'ascii');
    buf.writeUInt32LE(64, 60);
    buf.writeUInt32LE(0x4550, 64);
    buf.writeUInt16LE(machine, 68);
    await fs.writeFile(file, buf);
    return file;
  };
  try {
    const x64Exe = await writePe('x64', 'codex.exe', 0x8664);
    const armExe = await writePe('arm', 'codex.exe', 0xaa64);
    const wrongName = await writePe('other', 'other.exe', 0x8664);
    assert.equal(await nativeExecutable(x64Exe, 'x64'), true);
    assert.equal(await nativeExecutable(x64Exe, 'arm64'), true);
    assert.equal(await nativeExecutable(armExe, 'arm64'), true);
    assert.equal(await nativeExecutable(armExe, 'x64'), false);
    assert.equal(await nativeExecutable(wrongName, 'x64'), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
