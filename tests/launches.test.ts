import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LAUNCHES, appendLaunch, localStamp } from '../src/services/launches.js';

test('launch history appends, keeps the newest entries and drops malformed ones', () => {
  const first = appendLaunch(undefined, { at: 'a', uptimeMinutes: 1.2, kind: 'start' });
  assert.deepEqual(first, [{ at: 'a', uptimeMinutes: 1.2, kind: 'start' }]);
  const mixed = appendLaunch([{ at: 'a', uptimeMinutes: 1, kind: 'start' }, { at: 'b', kind: 'start' }, null, 'x', { at: 'c', uptimeMinutes: 2, kind: 'other' }],
    { at: 'd', uptimeMinutes: 3, kind: 'second' });
  assert.deepEqual(mixed.map(item => item.at), ['a', 'd']);
  let history: unknown = [];
  for (let index = 0; index < MAX_LAUNCHES + 5; index++) history = appendLaunch(history, { at: String(index), uptimeMinutes: index, kind: 'start' });
  assert.equal((history as unknown[]).length, MAX_LAUNCHES);
  assert.equal((history as { at: string }[])[0].at, '5');
  assert.equal(appendLaunch({}, { at: 'e', uptimeMinutes: 0, kind: 'boot-error', detail: 'x'.repeat(500) })[0].detail?.length, 300);
});

test('launch stamps use the PC time zone; British Columbia keeps its PST label', () => {
  assert.equal(localStamp(new Date(Date.UTC(2026, 9, 25, 4, 9, 39)), 'America/Vancouver'), '2026-10-24, 9:09:39 p.m. PST (UTC-07:00)');
  assert.match(localStamp(new Date(Date.UTC(2026, 0, 15, 12)), 'America/New_York'), /EST \(UTC-05:00\)$/);
  assert.match(localStamp(new Date(Date.UTC(2026, 0, 15, 12)), 'Asia/Tokyo'), /\(UTC\+09:00\)$/);
});
