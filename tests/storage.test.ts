import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteDf, readRemote, STORAGE_INTERVAL_MS, StorageProvider, type StorageConfig } from '../src/providers/storage.js';
import { compactDiskBytes, formatDiskBytes, validHost, validLabel, type DiskSpace } from '../src/shared/storage.js';

const withRemote = (): StorageConfig => ({ localLabel: 'This PC', localVolume: 'C:', remote: { host: 'server', label: 'Server' } });

test('a remote df reply accepts exact bytes, including a full disk; malformed data stays unknown', () => {
  assert.deepEqual(parseRemoteDf('1B-blocks       Avail\r\n241588117504 26831876096\r\n'), { totalBytes: 241588117504, freeBytes: 26831876096 });
  assert.equal(parseRemoteDf('1B-blocks Avail\n10 0').freeBytes, 0);
  for (const invalid of ['', 'permission denied', '1B-blocks Avail\n0 0', '1B-blocks Avail\n10 11', '1B-blocks Avail\n10 -1',
    '1B-blocks Used\n10 7', '1B-blocks Avail\n10 7\n10 8', '1B-blocks Avail\n9007199254740992 8'])
    assert.throws(() => parseRemoteDf(invalid));
  assert.equal(formatDiskBytes(26831876096), '26.8 GB');
  assert.equal(formatDiskBytes(0), '0 B');
  assert.equal(compactDiskBytes(0), '0 B');
  assert.equal(compactDiskBytes(512), '512 B');
  assert.equal(compactDiskBytes(45.6e6), '46 MB');
  assert.equal(compactDiskBytes(157.4e9), '157 GB');
  assert.equal(compactDiskBytes(1.24e12), '1.2 TB');
});

test('only a plain SSH host name is accepted, never anything ssh could read as an option', async () => {
  for (const good of ['server', 'my-host', 'host.example.com', 'h_1', '.hidden']) assert.equal(validHost(good), true, good);
  for (const bad of ['-oProxyCommand=calc', '-p', 'a b', 'host;rm', 'host\nx', '', 'x'.repeat(65), 'user@host', null, 7]) assert.equal(validHost(bad), false, String(bad));
  await assert.rejects(readRemote('-oProxyCommand=calc', new AbortController().signal), /plain SSH host/);
  for (const good of ['This PC', 'Server 2']) assert.equal(validLabel(good), true);
  for (const bad of ['', '   ', 'x'.repeat(25), '<b>', 'a\nb']) assert.equal(validLabel(bad), false);
});

test('a slow remote host does not delay the local reading; concurrent refreshes share one request', async () => {
  let finish!: (value: DiskSpace) => void;
  let reads = 0;
  const provider = new StorageProvider(() => {}, withRemote, {
    local: async () => ({ totalBytes: 100, freeBytes: 30 }),
    remote: () => { reads++; return new Promise(resolve => { finish = resolve; }); }
  });
  const pending = provider.refresh();
  assert.equal(provider.refresh(), pending);
  await Promise.resolve();
  assert.equal(provider.state().local.status, 'ready');
  assert.equal(provider.state().remote.reading, null);
  finish({ totalBytes: 100, freeBytes: 0 });
  await pending;
  assert.equal(reads, 1);
  assert.equal(provider.state().remote.reading?.freeBytes, 0);
  assert.equal(provider.state().remote.label, 'Server');
  await provider.stop();
});

test('with no remote host the remote row is off and never read; a changed host never shows the old reading', async () => {
  let config: StorageConfig = { localLabel: 'Desk', localVolume: 'D:', remote: null };
  let remoteReads = 0;
  const provider = new StorageProvider(() => {}, () => config, {
    local: async () => ({ totalBytes: 200, freeBytes: 70 }),
    remote: async () => { remoteReads++; return { totalBytes: 100, freeBytes: 20 }; }
  });
  await provider.refresh();
  assert.deepEqual(provider.state().remote, { status: 'off', reading: null, label: 'Remote', volume: '/' });
  assert.equal(remoteReads, 0);
  assert.deepEqual([provider.state().local.label, provider.state().local.volume], ['Desk', 'D:']);
  config = { ...config, remote: { host: 'one', label: 'One' } };
  await provider.refresh();
  assert.equal(provider.state().remote.reading?.freeBytes, 20);
  config = { ...config, remote: { host: 'two', label: 'Two' } };
  const before = provider.refresh();
  assert.equal(provider.state().remote.reading, null);
  await before;
  assert.equal(provider.state().remote.label, 'Two');
  config = { ...config, remote: null };
  await provider.refresh();
  assert.equal(provider.state().remote.status, 'off');
  await provider.stop();
});

test('a host change while the old host is still answering never shows the old reading under the new name', async () => {
  let config: StorageConfig = { localLabel: 'Desk', localVolume: 'C:', remote: { host: 'old', label: 'Old' } };
  let finishOld!: (value: DiskSpace) => void;
  const provider = new StorageProvider(() => {}, () => config, {
    local: async () => ({ totalBytes: 200, freeBytes: 70 }),
    remote: async () => config.remote?.host === 'old' ? new Promise(resolve => { finishOld = resolve; }) : { totalBytes: 100, freeBytes: 55 }
  });
  const oldRead = provider.refresh();
  await Promise.resolve();
  config = { ...config, remote: { host: 'new', label: 'New' } };
  await provider.refresh();
  finishOld({ totalBytes: 100, freeBytes: 1 });
  await oldRead;
  assert.equal(provider.state().remote.label, 'New');
  assert.equal(provider.state().remote.reading?.freeBytes, 55);
  await provider.stop();
});

test('a failed, expired or recovered reading never becomes a fabricated zero', async () => {
  let time = 2000, fail = true;
  const provider = new StorageProvider(() => {}, withRemote, {
    local: async () => ({ totalBytes: 200, freeBytes: 70 }),
    remote: async () => { if (fail) throw new Error('offline'); return { totalBytes: 100, freeBytes: 20 }; }
  }, () => time);
  await provider.refresh();
  assert.equal(provider.state().remote.status, 'unavailable'); assert.equal(provider.state().remote.reading, null);
  fail = false; await provider.refresh();
  time += 2 * STORAGE_INTERVAL_MS;
  assert.equal(provider.state().remote.status, 'stale');
  fail = true; await provider.refresh();
  assert.equal(provider.state().remote.status, 'stale');
  assert.deepEqual(provider.state().remote.reading, { totalBytes: 100, freeBytes: 20, observedAt: 2000 });
  assert.equal(provider.state().local.status, 'ready');
  fail = false; await provider.refresh();
  assert.equal(provider.state().remote.status, 'ready');
  await provider.stop();
});

test('pause cancels an active SSH read and ignores late replies after resuming', async () => {
  let late!: (value: DiskSpace) => void;
  let first: AbortSignal | undefined, reads = 0;
  const provider = new StorageProvider(() => {}, withRemote, {
    local: async () => ({ totalBytes: 200, freeBytes: 70 }),
    remote: async (signal: AbortSignal) => { if (++reads === 1) { first = signal; return new Promise(resolve => { late = resolve; }); } return { totalBytes: 100, freeBytes: 40 }; }
  });
  const pending = provider.refresh();
  provider.pause(); await provider.refresh();
  assert.equal(first?.aborted, true); assert.equal(reads, 1);
  provider.resume(); await provider.refresh();
  late({ totalBytes: 100, freeBytes: 20 }); await pending;
  assert.equal(provider.state().remote.reading?.freeBytes, 40);
  await provider.stop(); provider.resume(); await provider.refresh();
  assert.equal(reads, 2);
});
