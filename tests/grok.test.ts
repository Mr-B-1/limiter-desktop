import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findPython, fromCli, parseGrok, readGrokQuota, reloginRequired, GrokProvider, type GrokRead } from '../src/providers/grok.js';

const weekly = { source: 'credits', period: 'weekly', usedPercent: 42.5, remainingPercent: 57.5, resetsAt: '2026-10-16T06:00:00.000Z', products: [{ name: 'GrokChat', usedPercent: 10 }] };
test('Grok keeps a missing subscription percentage distinct from zero and from API balances', () => {
  assert.equal(parseGrok(weekly, 100).usedPercent, 42.5);
  assert.equal(parseGrok(weekly, 100).resetsAt, Math.floor(Date.parse(weekly.resetsAt) / 1000));
  const omitted = parseGrok({ source: 'credits', period: 'weekly', usedPercent: null, remainingPercent: null, resetsAt: '2026-10-16T06:00:00.000Z', products: [], prepaidBalance: 50, onDemandUsed: 0 }, 100);
  assert.equal(omitted.usedPercent, null);
  assert.equal(JSON.stringify(omitted).includes('prepaid'), false);
  assert.throws(() => parseGrok({ ...weekly, usedPercent: null }));
  assert.throws(() => parseGrok({ ...weekly, usedPercent: 140, remainingPercent: 0 }));
  assert.throws(() => parseGrok({ ...weekly, source: 'spending' }));
});
test('Grok reader reports sign-in, throttle, and account changes without retaining the old meter', async () => {
  let now = 100000;
  let result: GrokRead = { ok: true, scope: 'a'.repeat(64), summary: weekly };
  const provider = new GrokProvider(() => {}, async () => result, () => now);
  await provider.refresh();
  assert.equal(provider.state().status, 'ready');
  assert.equal(provider.state().snapshot?.usedPercent, 42.5);
  assert.doesNotMatch(JSON.stringify(provider.state()), /Authorization|access_token|user_id/);
  now += 10001;
  result = { ok: false, status: 'throttled' };
  await provider.refresh();
  assert.equal(provider.state().status, 'throttled');
  assert.equal(provider.state().snapshot?.usedPercent, 42.5);
  now += 10001;
  await provider.refresh();
  assert.equal(provider.state().status, 'throttled');
  now += 15 * 60000;
  result = { ok: false, status: 'signed-out' };
  await provider.refresh();
  assert.equal(provider.state().snapshot, null);
  assert.equal(provider.state().status, 'signed-out');
  now += 10001;
  result = { ok: true, scope: 'b'.repeat(64), summary: { ...weekly, usedPercent: 9, remainingPercent: 91 } };
  await provider.refresh('scheduled');
  assert.equal(provider.state().status, 'signed-out', 'a scheduled read is held after a sign-in failure');
  provider.pause(); await provider.refresh('scheduled'); provider.resume();
  assert.equal(provider.state().status, 'signed-out', 'resume never lifts a hold');
  await provider.refresh('manual');
  assert.equal(provider.state().snapshot?.usedPercent, 9);
  assert.doesNotMatch(JSON.stringify(provider.state()), /bbbb/);
  await provider.stop();
  assert.equal(provider.state().snapshot, null);
});
test('grokcli quota JSON maps onto the reader shape and keeps unknown distinct from zero', () => {
  const cli = { source: 'credits', period: { type: 'weekly', start: '2026-10-09T06:00:00Z', end: '2026-10-16T06:00:00Z' }, used_percent: 42.5, remaining_percent: 57.5,
    resets_at: '2026-10-16T06:00:00Z', products: [{ name: 'GrokChat', used_percent: 10 }], prepaid_balance: 50 };
  const parsed = parseGrok(fromCli(cli), 100);
  assert.equal(parsed.remainingPercent, 57.5); assert.equal(parsed.period, 'weekly');
  assert.equal(parsed.resetsAt, Math.floor(Date.parse('2026-10-16T06:00:00Z') / 1000));
  assert.deepEqual(parsed.products, [{ name: 'GrokChat', usedPercent: 10 }]);
  assert.equal(parseGrok(fromCli({ ...cli, used_percent: null, remaining_percent: null }), 100).remainingPercent, null);
  assert.equal(parseGrok(fromCli({ ...cli, source: 'legacy', used_percent: null, remaining_percent: 0 }), 100).remainingPercent, null);
  assert.throws(() => fromCli('text'));
  assert.throws(() => parseGrok(fromCli({ ...cli, source: 'spending' })));
});
test('Grok reader runs only grokcli quota, maps its exit codes and needs Python plus the checkout', async () => {
  assert.deepEqual(await readGrokQuota('C:/missing-grokcli', 'C:/missing/python.exe'), { ok: false, status: 'setup' });
  assert.deepEqual(await readGrokQuota('C:/missing-grokcli', null), { ok: false, status: 'setup' });
  assert.equal(findPython({ PATH: 'relative;' }), null);
  const python = findPython();
  if (!python) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'limiter-grokcli-'));
  try {
    await mkdir(path.join(root, 'grokcli'));
    await writeFile(path.join(root, 'grokcli', '__init__.py'), '');
    await writeFile(path.join(root, 'grokcli', 'cli.py'), '');
    // The fake records its arguments, so the test proves Limiter asks for quota and nothing else.
    const fake = (body: string) => writeFile(path.join(root, 'grokcli', '__main__.py'), 'import sys, json\nassert sys.argv[1:] == ["quota", "--output", "json"], sys.argv\n' + body);
    await fake('print(json.dumps({"source": "credits", "period": {"type": "weekly"}, "used_percent": 9, "remaining_percent": 91, "resets_at": None, "products": []}))\n');
    const ok = await readGrokQuota(root, python);
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && parseGrok(ok.summary).remainingPercent, 91);
    for (const [code, status] of [[3, 'signed-out'], [4, 'throttled'], [5, 'timeout'], [6, 'offline'], [2, 'compatibility']] as const) {
      await fake('sys.stderr.write("secret-token-text")\nsys.exit(' + code + ')\n');
      assert.deepEqual(await readGrokQuota(root, python), { ok: false, status });
    }
    await fake('sys.stderr.write(json.dumps({"error": {"code": 3, "message": "tier denied", "relogin_required": False}}))\nsys.exit(3)\n');
    assert.deepEqual(await readGrokQuota(root, python), { ok: false, status: 'unauthorized' });
    await fake('sys.stderr.write(json.dumps({"error": {"code": 3, "relogin_required": True}}))\nsys.exit(3)\n');
    assert.deepEqual(await readGrokQuota(root, python), { ok: false, status: 'signed-out' });
    assert.equal(reloginRequired('progress\n{"error": {"relogin_required": true}}\n'), true);
    assert.equal(reloginRequired('not json'), null);
    await fake('print("not json")\n');
    assert.deepEqual(await readGrokQuota(root, python), { ok: false, status: 'compatibility' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
