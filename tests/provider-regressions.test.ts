import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ClaudeEstimator, ClaudeLogScanner, WEIGHTING } from '../src/providers/claude-local.js';
import { newestExact } from '../src/providers/claude-mod.js';
import { CodexRolloutReader } from '../src/providers/codex-rollouts.js';
import { GrokProvider, findPython, readGrokQuota } from '../src/providers/grok.js';
import { StorageProvider, type StorageConfig } from '../src/providers/storage.js';
import { defaultRoots } from '../src/shared/projects.js';

const now = Date.UTC(2026, 10, 18, 18);
const waiting = { status: 'waiting' as const, sample: null, ageMs: null };
const reply = (id: string, cwd = 'C:/Projects/Alpha') => JSON.stringify({ type: 'assistant', requestId: 'req-' + id,
  timestamp: new Date(now - 60000).toISOString(), cwd,
  message: { id: 'msg-' + id, model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 1000 } } });
const meta = (id: string, cwd: string) => JSON.stringify({ type: 'session_meta', payload: { id, cwd } });
const usage = (total = 110) => JSON.stringify({ type: 'event_msg', timestamp: new Date(now - 60000).toISOString(),
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total - 10, cached_input_tokens: 0, output_tokens: 10, total_tokens: total } } } });
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-provider-regression-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

for (const operation of ['open', 'readdir'] as const) {
  test('Claude ' + operation + ' failure remains unknown and recovers on retry', async t => withRoot(async root => {
    await fs.writeFile(path.join(root, 'session.jsonl'), reply('one') + '\n');
    const estimator = new ClaudeEstimator(() => {}, () => {}, { weeklyCapacity: 0.048, fiveHourCapacity: null,
      weeklyResetAt: now + 86400000, fiveHourResetAt: null, anchoredAt: now - 3600000, source: 'manual', weighting: WEIGHTING }, root, () => ({ wall: now, mono: 100 }));
    const failure = t.mock.method(fs, operation, async () => { throw Object.assign(new Error('read denied'), { code: 'EACCES' }); });
    try {
      estimator.start(); await estimator.refresh();
      assert.equal(estimator.view(waiting).mode, 'unavailable');
      assert.equal(estimator.view(waiting).weekly.percent, null);
      failure.mock.restore();
      await estimator.refresh();
      assert.equal(estimator.view(waiting).mode, 'estimate');
      assert.equal(estimator.view(waiting).weekly.percent, 50);
    } finally { failure.mock.restore(); estimator.stop(); }
  }));
}

test('an empty or stale exact feed cannot replace a ready usable Claude reading', () => {
  const sample = { schemaVersion: 1 as const, observedAt: now, fiveHour: null, sevenDay: { usedPercent: 30, resetsAt: now / 1000 + 3600 } };
  const mod = { status: 'ready' as const, sample, ageMs: 0, host: 'fixture' };
  const empty = { status: 'waiting' as const, sample: { ...sample, observedAt: now + 1, sevenDay: null }, ageMs: 0 };
  assert.equal(newestExact(empty, mod).source, 'mod');
  assert.equal(newestExact({ status: 'stale', sample: { ...sample, observedAt: now + 1 }, ageMs: 0 }, mod).source, 'mod');
  assert.equal(newestExact({ ...mod, status: 'ready' }, { ...empty, host: 'fixture' }).source, 'status-line');
  assert.equal(newestExact({ ...waiting }, { ...waiting, host: null }).source, null);
});

test('Codex retries an unreadable unchanged file, then caches the successful read', async t => withRoot(async root => {
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, meta('session-one', 'C:/Projects/Alpha') + '\n' + usage() + '\n');
  const reader = new CodexRolloutReader(root);
  const open = fs.open;
  let attempts = 0;
  t.mock.method(fs, 'open', async (name: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
    if (String(name) === file && ++attempts === 1) throw Object.assign(new Error('read denied'), { code: 'EACCES' });
    return open(name, flags, mode);
  });
  await reader.scan(now);
  assert.equal(reader.coverage().unreadable, 1);
  await reader.scan(now); await reader.scan(now);
  assert.equal(attempts, 2);
  assert.equal(reader.coverage().unreadable, 0);
  assert.equal(reader.events(now - 3600000, now)[0]?.tokens, 110);
}));

test('both readers merge Windows case variants while keeping POSIX case variants separate', async () => withRoot(async root => {
  for (const [kind, folder, variants, expectedRows] of [
    ['windows', 'C:/Projects', ['C:/Projects/Alpha', 'c:/projects/alpha'], 1],
    ['posix', '/projects', ['/projects/Alpha', '/projects/alpha'], 2]
  ] as const) {
    const claudeRoot = path.join(root, kind, 'claude'), codexRoot = path.join(root, kind, 'codex');
    await fs.mkdir(claudeRoot, { recursive: true }); await fs.mkdir(codexRoot, { recursive: true });
    await fs.writeFile(path.join(claudeRoot, 'session.jsonl'), variants.map((cwd, index) => reply(String(index), cwd)).join('\n') + '\n');
    for (const [index, cwd] of variants.entries()) {
      await fs.writeFile(path.join(codexRoot, `session-${index}.jsonl`), meta('session-' + index, cwd) + '\n' + usage() + '\n');
    }
    const claude = new ClaudeLogScanner(claudeRoot), codex = new CodexRolloutReader(codexRoot);
    await claude.scan(now); await codex.scan(now);
    const roots = defaultRoots('C:/home', folder);
    const claudeRows = claude.byProject(now - 3600000, now, roots), codexRows = codex.byProject(now - 3600000, now, roots);
    assert.equal(claudeRows.length, expectedRows, kind + ' Claude');
    assert.equal(codexRows.length, expectedRows, kind + ' Codex');
    assert.equal(claudeRows.reduce((sum, row) => sum + row.tokens, 0), 4000);
    assert.equal(codexRows.reduce((sum, row) => sum + row.tokens, 0), 220);
    if (kind === 'windows') { assert.equal(claudeRows[0].name, 'Alpha'); assert.equal(codexRows[0].name, 'Alpha'); }
  }
}));

test('a configured host change hides the previous disk reading before refresh starts', async () => {
  let config: StorageConfig = { localLabel: 'Desk', localVolume: 'C:', remote: { host: 'old', label: 'Old' } };
  const provider = new StorageProvider(() => {}, () => config, {
    local: async () => ({ totalBytes: 100, freeBytes: 20 }),
    remote: async () => ({ totalBytes: 100, freeBytes: config.remote?.host === 'old' ? 20 : 55 })
  });
  await provider.refresh();
  config = { ...config, remote: { host: 'new', label: 'New' } };
  assert.equal(provider.state().remote.label, 'New');
  assert.equal(provider.state().remote.reading, null);
  assert.equal(provider.state().remote.status, 'waiting');
  await provider.refresh();
  assert.equal(provider.state().remote.reading?.freeBytes, 55);
  await provider.stop();
});

test('Grok stop cancels its owned quota child and waits for its exit', async t => {
  const python = findPython();
  if (!python) { t.skip('Python is not available for the isolated child check'); return; }
  await withRoot(async root => {
    await fs.mkdir(path.join(root, 'grokcli'));
    for (const name of ['__init__.py', 'cli.py']) await fs.writeFile(path.join(root, 'grokcli', name), '');
    await fs.writeFile(path.join(root, 'grokcli', '__main__.py'), 'import os, time\nfrom pathlib import Path\nPath("pid").write_text(str(os.getpid()))\ntime.sleep(60)\n');
    const provider = new GrokProvider(() => {}, signal => readGrokQuota(root, python, signal));
    const pending = provider.refresh();
    try {
      let pid = 0;
      for (let attempt = 0; attempt < 500 && !pid; attempt++) {
        pid = Number(await fs.readFile(path.join(root, 'pid'), 'utf8').catch(() => '0'));
        if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert(pid > 0, 'The isolated quota helper must start');
      const started = performance.now();
      await provider.stop(); await pending;
      assert(performance.now() - started < 2000, 'Stop must cancel the 20-second transport timeout');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(provider.state().snapshot, null);
    } finally { await provider.stop(); await pending; }
  });
});

test('Codex rejects oversized complete records before decoding, including compressed final tails', async () => withRoot(async root => {
  const limit = 1024;
  const record = usage(220);
  const oversized = record + ' '.repeat(limit - Buffer.byteLength(record) + 1);
  for (const [name, compressed, terminated] of [['plain.jsonl', false, true], ['complete.jsonl.zst', true, true], ['tail.jsonl.zst', true, false]] as const) {
    const folder = path.join(root, name.replaceAll('.', '-'));
    await fs.mkdir(folder);
    const text = meta('session-' + name, 'C:/Projects/Alpha') + '\n' + oversized + (terminated ? '\n' + usage() + '\n' : '');
    await fs.writeFile(path.join(folder, name), compressed ? zlib.zstdCompressSync(Buffer.from(text)) : text);
    const reader = new CodexRolloutReader(folder, limit);
    await reader.scan(now);
    assert.equal(reader.coverage().malformedLines, 1, name);
    assert.equal(reader.events(now - 3600000, now).length, terminated ? 1 : 0, name);
    if (terminated) assert.equal(reader.events(now - 3600000, now)[0]?.tokens, 110, name);
  }
}));

test('Claude rejects an oversized record completed across a chunk boundary and reads the following reply', async () => withRoot(async root => {
  const limit = 32 * 1024 * 1024;
  const line = reply('oversized');
  // A tail exactly at the limit ends in the next chunk, before the unfinished-tail size check runs.
  const oversized = line + ' '.repeat(limit - Buffer.byteLength(line) + 1);
  await fs.writeFile(path.join(root, 'session.jsonl'), oversized + '\n' + reply('following') + '\n');
  const scanner = new ClaudeLogScanner(root);
  await scanner.scan(now);
  assert.equal(scanner.replies, 1);
  assert.equal(scanner.timeline()[0]?.tokens, 2000);
  assert.equal(scanner.units(now - 3600000, now), 0.024);
}));

test('Codex rejects an oversized plain record completed across a chunk boundary and reads the following event', async () => withRoot(async root => {
  const limit = 32 * 1024 * 1024;
  const line = usage(220);
  const oversized = line + ' '.repeat(limit - Buffer.byteLength(line) + 1);
  await fs.writeFile(path.join(root, 'session.jsonl'), meta('boundary', 'C:/Projects/Alpha') + '\n' + oversized + '\n' + usage() + '\n');
  const reader = new CodexRolloutReader(root);
  await reader.scan(now);
  assert.equal(reader.coverage().malformedLines, 1);
  assert.equal(reader.events(now - 3600000, now).length, 1);
  assert.equal(reader.events(now - 3600000, now)[0]?.tokens, 110);
}));
