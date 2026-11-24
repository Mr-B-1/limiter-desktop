import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityGate } from '../src/services/activity.js';
import { insidePackage, relayArgs, startedByAgent, startupShortcut } from '../src/services/launch-guard.js';

test('activity gate pauses on idle or lock and resumes once on activity', () => {
  let idle = 0; const events: string[] = [];
  const gate = new ActivityGate(() => idle, () => events.push('idle'), () => events.push('active'), 300);
  gate.tick(); gate.tick();
  assert.deepEqual(events, [], 'active at start is not a transition');
  idle = 299; gate.tick(); idle = 300; gate.tick(); gate.tick();
  assert.deepEqual(events, ['idle']);
  idle = 2; gate.tick();
  assert.deepEqual(events, ['idle', 'active']);
  gate.lock(); gate.tick();
  assert.deepEqual(events, ['idle', 'active', 'idle']);
  gate.unlock();
  assert.deepEqual(events, ['idle', 'active', 'idle', 'active']); assert.equal(gate.paused, false);
});

test('launch guard reads the package identity, keeps relay arguments and names the startup shortcut', () => {
  assert.equal(typeof insidePackage(), 'boolean');
  assert.equal(insidePackage(() => 15700), false); assert.equal(insidePackage(() => 122), true); assert.equal(insidePackage(null), false);
  assert.equal(insidePackage(() => { throw new Error('no api'); }), false);
  assert.deepEqual(relayArgs(['Limiter.exe', '--quit', '--diagnose-projects', '--claude-weekly=80', '--force-device-scale-factor=1']), ['--quit', '--diagnose-projects', '--claude-weekly=80']);
  assert.equal(startupShortcut('C:\\Users\\x\\AppData\\Roaming'), 'C:\\Users\\x\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Limiter.lnk');
  assert.equal(startupShortcut(null), null);
  assert.equal(startedByAgent({ PATH: 'x' }), false);
  assert.equal(startedByAgent({ CLAUDECODE: '1' }), true);
  assert.equal(startedByAgent({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }), true);
  assert.equal(startedByAgent({ CLAUDE_CODE_ENTRYPOINT: '' }), false);
});
