import test from 'node:test';
import assert from 'node:assert/strict';
import { AlertTracker } from '../src/services/alerts.js';

const now = Date.UTC(2026, 9, 9, 20);
const reset = Math.floor((now + 3 * 3600000) / 1000);
test('alerts fire once per threshold per window, re-arm on a new window, and skip unknown or passed windows', () => {
  const tracker = new AlertTracker();
  const row = (left: number | null, resetsAt: number | null = reset, estimate = false) => ({ key: 'claude-week', label: 'Claude Code weekly', left, resetsAt, estimate });
  assert.deepEqual(tracker.evaluate([row(45)], now), []);
  const first = tracker.evaluate([row(19.5, reset, true)], now);
  assert.equal(first.length, 1); assert.equal(first[0].title, 'Claude Code weekly: ≈19.5% left'); assert.match(first[0].body, /Running low. Resets in 3h 0m\./);
  assert.deepEqual(tracker.evaluate([row(12)], now), [], 'no repeat inside the window');
  const second = tracker.evaluate([row(4)], now);
  assert.equal(second.length, 1); assert.match(second[0].body, /^Almost out\./);
  assert.deepEqual(tracker.evaluate([row(3)], now), []);
  assert.equal(tracker.evaluate([row(3, reset + 18000)], now).length, 2, 'a new window re-arms both thresholds');
  assert.deepEqual(tracker.evaluate([row(null)], now), []);
  assert.deepEqual(tracker.evaluate([row(2, Math.floor(now / 1000) - 1)], now), []);
  const twoRows = tracker.evaluate([row(1, reset + 36000), { key: 'grok', label: 'Grok weekly', left: 10, resetsAt: reset + 36000, estimate: false }], now);
  assert.equal(twoRows.length, 3);
  assert.match(twoRows.find(toast => toast.title.startsWith('Grok'))!.body, /Running low/);
});
