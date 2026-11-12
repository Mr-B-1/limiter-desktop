import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuota } from '../src/providers/quota.js';
import { ageLabel, countdown, resetLabel, windowLabel } from '../src/shared/usage.js';
const window = (duration: number | null = 10080, used: number | null = 32) => ({ usedPercent: used, windowDurationMins: duration, resetsAt: 2000000000 });
const parse = (value: unknown) => parseQuota(value, 1, 'pro', true, 100000);
test('weekly primary selection and remaining capacity match the source', () => {
  const result = parse({ rateLimitsByLimitId: { codex: { primary: window() } } });
  assert.equal(result.selectedKey, 'codex:primary');
  assert.equal(result.windows[0].remainingPercent, 68);
});
test('weekly secondary is selected by duration rather than slot', () => {
  const result = parse({ rateLimitsByLimitId: { codex: { primary: window(300), secondary: window() } } });
  assert.equal(result.selectedKey, 'codex:secondary');
});
test('Codex weekly is primary while every extra bucket remains separate', () => {
  const result = parse({ rateLimitsByLimitId: { other: { primary: window(10080, 90) }, codex: { primary: window(10080, 12) } } });
  assert.equal(result.selectedKey, 'codex:primary');
  assert.equal(result.windows.length, 2);
});
test('two weekly limits without an authoritative Codex row are ambiguous', () => {
  const result = parse({ rateLimitsByLimitId: { a: { primary: window() }, b: { primary: window() } } });
  assert.equal(result.selection, 'ambiguous');
  assert.equal(result.selectedKey, null);
  assert.equal(result.windows.length, 2);
});
test('same duration in two slots cannot be merged', () => {
  const result = parse({ rateLimitsByLimitId: { codex: { primary: window(), secondary: window() } } });
  assert.equal(result.selection, 'ambiguous');
  assert.equal(result.windows.length, 2);
});
test('bucket identity conflicts disable primary selection', () => {
  const result = parse({ rateLimitsByLimitId: { codex: { limitId: 'different', primary: window() } } });
  assert.equal(result.selection, 'ambiguous');
});
test('modern empty map is authoritative over legacy quota', () => {
  const result = parse({ rateLimitsByLimitId: {}, rateLimits: { primary: window() } });
  assert.equal(result.windows.length, 0);
});
test('legacy source is accepted only when map is absent or null', () => {
  assert.equal(parse({ rateLimitsByLimitId: null, rateLimits: { limitId: 'codex', primary: window() } }).selectedKey, 'codex:primary');
});
test('missing quota is unavailable rather than zero', () => {
  const result = parse({ rateLimits: null });
  assert.equal(result.selection, 'absent');
  assert.deepEqual(result.windows, []);
});
test('null used percent stays unavailable while a real zero stays zero', () => {
  const result = parse({ rateLimitsByLimitId: { a: { primary: window(10080, null) }, b: { primary: window(10080, 0) } } });
  assert.equal(result.windows[0].usedPercent, null);
  assert.equal(result.windows[0].remainingPercent, null);
  assert.equal(result.windows[1].remainingPercent, 100);
});
for (const value of ['50', -1, 1.5, NaN, Infinity]) {
  test('malformed percentage is rejected: ' + String(value), () => {
    assert.throws(() => parse({ rateLimitsByLimitId: { codex: { primary: { ...window(), usedPercent: value } } } }), { kind: 'compatibility' });
  });
}
test('nullable duration and reset do not receive guessed values', () => {
  const result = parse({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 12, resetsAt: null } } } });
  assert.equal(result.selection, 'absent');
  assert.equal(result.windows[0].durationMins, null);
  assert.equal(result.windows[0].resetsAt, null);
});
test('additional permissions restrictions survive the quota projection', () => {
  const result = parse({ rateLimitsByLimitId: { codex: { spendControlReached: true, primary: window(10080, 0) } } });
  assert.equal(result.windows[0].restricted, true);
});
test('local reset formatting keeps winter and summer offsets with PST labels', () => {
  assert.match(resetLabel(Date.UTC(2025, 0, 15, 20) / 1000, 'America/Vancouver'), /PST \(UTC-08:00\)/);
  assert.match(resetLabel(Date.UTC(2025, 6, 15, 20) / 1000, 'America/Vancouver'), /PST \(UTC-07:00\)/);
});
test('expired and unknown resets remain explicit', () => {
  assert.equal(countdown(10, 10001), 'Reset passed, awaiting data');
  assert.equal(countdown(null), 'Reset unavailable');
  assert.equal(windowLabel(null), 'Unclassified limit');
  assert.equal(ageLabel(null), 'Awaiting first read');
});
