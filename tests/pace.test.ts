import test from 'node:test';
import assert from 'node:assert/strict';
import { FIVE_HOUR_MS, WEEK_MS, paceOf } from '../src/shared/pace.js';
import { Forecast } from '../src/services/forecast.js';

const now = Date.UTC(2026, 9, 9, 20);
test('pace compares used percent with elapsed window time', () => {
  const halfway = Math.floor((now + WEEK_MS / 2) / 1000);
  assert.deepEqual(paceOf(50, halfway, WEEK_MS, now), { elapsedPercent: 50, aheadBy: 0, label: 'on pace' });
  assert.equal(paceOf(80, halfway, WEEK_MS, now)?.label, 'ahead of pace');
  assert.equal(paceOf(20, halfway, WEEK_MS, now)?.label, 'behind pace');
  const justStarted = Math.floor((now + FIVE_HOUR_MS - 60000) / 1000);
  assert.equal(paceOf(3, justStarted, FIVE_HOUR_MS, now)?.elapsedPercent, 0.3);
  assert.equal(paceOf(50, Math.floor(now / 1000) - 1, WEEK_MS, now), null);
  assert.equal(paceOf(null, halfway, WEEK_MS, now), null);
  assert.equal(paceOf(50, null, WEEK_MS, now), null);
});

test('forecast projects time to empty from the last hour and knows when the reset comes first', () => {
  let clock = now;
  const forecast = new Forecast(() => clock);
  const reset = Math.floor((now + 2 * 3600000) / 1000);
  forecast.observe('claude-5h', 10, reset);
  assert.equal(forecast.project('claude-5h', reset), null, 'one reading is not a trend');
  clock += 10 * 60000; forecast.observe('claude-5h', 20, reset);
  const view = forecast.project('claude-5h', reset);
  assert.equal(view?.ratePerHour, 60);
  assert.equal(view?.emptyAt, clock + 80 * 60000);
  assert.equal(view?.pastReset, false);
  const lateReset = Math.floor((clock + 30 * 60000) / 1000);
  forecast.observe('grok', 10, lateReset); clock += 10 * 60000; forecast.observe('grok', 11, lateReset);
  assert.equal(forecast.project('grok', lateReset)?.pastReset, true, 'reset arrives before empty');
  forecast.observe('codex', 40, reset); clock += 10 * 60000; forecast.observe('codex', 40, reset);
  assert.deepEqual(forecast.project('codex', reset), { emptyAt: null, pastReset: true, ratePerHour: 0 });
  forecast.observe('claude-5h', 5, reset + 18000);
  assert.equal(forecast.project('claude-5h', reset), null, 'a new window starts the history over');
  forecast.observe('claude-5h', null, null);
  assert.equal(forecast.project('claude-5h', reset + 18000), null);
});
