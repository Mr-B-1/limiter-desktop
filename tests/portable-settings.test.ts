import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreferenceStore, defaults, parsePreferences } from '../src/services/store.js';
import { LoginItem, memoryLoginItemOs } from '../src/services/login-item.js';

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-portable-'));
  try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('a fresh profile has every per-user setting empty and is marked fresh', async () => withDirectory(async directory => {
  const store = new PreferenceStore(directory);
  const loaded = await store.load();
  assert.equal(store.fresh, true);
  assert.deepEqual([loaded.projectsRoot, loaded.grokcliRoot, loaded.localDiskLabel, loaded.remoteDisk], [null, null, null, null]);
  await store.save(loaded);
  const again = new PreferenceStore(directory);
  await again.load();
  assert.equal(again.fresh, false);
}));

test('schema 3 keeps valid settings and refuses unsafe ones', () => {
  const folder = path.join(os.tmpdir(), 'projects');
  const parsed = parsePreferences({ ...defaults(), projectsRoot: folder, grokcliRoot: folder, localDiskLabel: ' Desk ', remoteDisk: { host: 'server', label: ' Server ' } });
  assert.deepEqual([parsed.projectsRoot, parsed.grokcliRoot, parsed.localDiskLabel, parsed.remoteDisk], [folder, folder, 'Desk', { host: 'server', label: 'Server' }]);
  for (const bad of [{ projectsRoot: 'relative\\path' }, { grokcliRoot: 7 }, { projectsRoot: 'C:\\x\u0000y' }, { localDiskLabel: 'x'.repeat(25) },
    { remoteDisk: { host: '-oProxyCommand=calc', label: 'x' } }, { remoteDisk: { host: 'server' } }, { remoteDisk: 'server' }])
    assert.throws(() => parsePreferences({ ...defaults(), ...bad }), JSON.stringify(bad));
});

test('an older settings file reads with the new settings empty and keeps a one-time copy before the first schema 3 write', async () => withDirectory(async directory => {
  const legacy = { schemaVersion: 2, pinned: false, theme: 'dark', bounds: { x: 10, y: 20, width: 300, height: 480 }, codexPath: null, lastCodexPath: null, claudeCalibration: null };
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(legacy));
  const store = new PreferenceStore(directory);
  const loaded = await store.load();
  assert.equal(store.fresh, false);
  assert.equal(loaded.theme, 'dark');
  assert.deepEqual(loaded.bounds, legacy.bounds);
  assert.equal(loaded.projectsRoot, null);
  await store.save({ ...loaded, localDiskLabel: 'Desk' });
  const backup = JSON.parse(await fs.readFile(path.join(directory, 'settings.pre-v3.json'), 'utf8'));
  assert.deepEqual(backup, legacy);
  await store.save({ ...loaded, localDiskLabel: 'Other' });
  // The copy is written once and never overwritten by later saves.
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'settings.pre-v3.json'), 'utf8')), legacy);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).schemaVersion, 3);
}));

test('start with Windows sets the exact executable and checks the result', () => {
  const memory = memoryLoginItemOs();
  const item = new LoginItem(memory, 'C:\\Apps\\Limiter\\Limiter.exe');
  assert.equal(item.enabled(), false);
  item.set(true);
  assert.equal(item.enabled(), true);
  item.set(false);
  assert.deepEqual(memory.calls, [{ openAtLogin: true, path: 'C:\\Apps\\Limiter\\Limiter.exe' }, { openAtLogin: false, path: 'C:\\Apps\\Limiter\\Limiter.exe' }]);
  const ignoring = new LoginItem({ get: () => ({ openAtLogin: false }), set: () => undefined }, 'C:\\x.exe');
  assert.throws(() => ignoring.set(true), /did not add/);
  const broken = new LoginItem({ get: () => { throw new Error('denied'); }, set: () => undefined }, 'C:\\x.exe');
  assert.equal(broken.enabled(), false);
});
