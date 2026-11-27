import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreferenceStore, clampBounds, defaults, parsePreferences } from '../src/services/store.js';
async function fixture(run: (store: PreferenceStore, root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-store-test-'));
  try { await run(new PreferenceStore(root), root); }
  finally { await fs.rm(root, { recursive: true }); }
}
test('persisted preferences exclude supplied account and quota fields', async () => fixture(async (store, root) => {
  await store.save({ ...defaults(), pinned: false, ...{ account: 'fixture', quota: 50 } });
  const saved = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['bounds', 'claudeCalibration', 'codexPath', 'grokcliRoot', 'lastCodexPath', 'localDiskLabel', 'pinned', 'projectsRoot', 'remoteDisk', 'schemaVersion', 'theme']);
  assert.equal((await store.load()).pinned, false);
}));
test('Claude calibration persists capacity and reset only, and a bad value never resets other preferences', async () => fixture(async (store, root) => {
  const calibration = { weeklyCapacity: 1841.6, fiveHourCapacity: 464, weeklyResetAt: 1791601200000, fiveHourResetAt: null, anchoredAt: 1791556380000, source: 'manual' as const, weighting: 2 as const };
  await store.save({ ...defaults(), theme: 'dark', claudeCalibration: { ...calibration, ...{ weeklyPercent: 80, transcript: 'private' } } });
  const saved = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.claudeCalibration, calibration);
  assert.deepEqual((await store.load()).claudeCalibration, calibration);
  for (const broken of [{ ...calibration, weeklyCapacity: -1 }, { ...calibration, source: 'guess' }, { ...calibration, anchoredAt: null }, 'text'])
    assert.equal(parsePreferences({ ...defaults(), theme: 'light', claudeCalibration: broken }).claudeCalibration, null);
  const legacy = parsePreferences({ schemaVersion: 2, pinned: false, theme: 'light', bounds: null, codexPath: null, lastCodexPath: null });
  assert.equal(legacy.claudeCalibration, null); assert.equal(legacy.theme, 'light');
}));
test('corrupt settings recover previous preferences and preserve original bytes', async () => fixture(async (store, root) => {
  await store.save({ ...defaults(), pinned: false });
  await store.save(defaults());
  await fs.writeFile(path.join(root, 'settings.json'), '{broken');
  const recovered = await store.load();
  assert.equal(recovered.pinned, false);
  assert.equal(await fs.readFile(path.join(root, 'settings.recovery.json'), 'utf8'), '{broken');
  assert.match(store.notice || '', /Recovered/);
}));
test('unknown versions stay preserved while the app uses defaults', async () => fixture(async (store, root) => {
  const unknown = JSON.stringify({ schemaVersion: 999 });
  await fs.writeFile(path.join(root, 'settings.json'), unknown);
  assert.deepEqual(await store.load(), defaults());
  assert.equal(await fs.readFile(path.join(root, 'settings.recovery.json'), 'utf8'), unknown);
}));
test('concurrent saves serialize into complete valid preference files', async () => fixture(async (store) => {
  await Promise.all([store.save({ ...defaults(), theme: 'dark' }), store.save({ ...defaults(), theme: 'light' })]);
  assert.equal((await store.load()).theme, 'light');
}));
test('bounds clamp onto a remaining monitor after disconnect', () => {
  const result = clampBounds({ x: 4000, y: -900, width: 324, height: 420 }, [{ x: 0, y: 0, width: 1920, height: 1080 }]);
  assert.equal(result.x, 1596); assert.equal(result.y, 0);
});
test('negative-coordinate monitor remains a valid display', () => {
  const bounds = { x: -1000, y: 20, width: 324, height: 420 };
  assert.deepEqual(clampBounds(bounds, [{ x: -1920, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }]), bounds);
});
test('invalid preference paths and dimensions are rejected', () => {
  assert.throws(() => parsePreferences({ ...defaults(), codexPath: 'codex.cmd' }));
  assert.throws(() => parsePreferences({ ...defaults(), bounds: { x: 0, y: 0, width: -1, height: 420 } }));
});
test('a resized desktop widget keeps its dimensions after a new store loads the saved file', async () => fixture(async (store, root) => {
  const bounds = { x: -700, y: 45, width: 580, height: 620 };
  await store.save({ ...defaults(), bounds });
  assert.deepEqual((await new PreferenceStore(root).load()).bounds, bounds);
}));
test('v1 floating preferences migrate to the compact desktop layout while preserving position and theme', () => {
  const parsed = parsePreferences({ ...defaults(), schemaVersion: 1, pinned: true, theme: 'dark', bounds: { x: -700, y: 45, width: 324, height: 452 } });
  assert.equal(parsed.schemaVersion, 3); assert.equal(parsed.pinned, false); assert.equal(parsed.theme, 'dark');
  assert.deepEqual(parsed.bounds, { x: -700, y: 45, width: 270, height: 220 });
});
