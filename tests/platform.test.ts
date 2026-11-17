import test from 'node:test';
import assert from 'node:assert/strict';
import { MACHINE_AMD64, MACHINE_ARM64, displayTimeZone, parseRegZone, wrongBuildForPc } from '../src/shared/platform.js';
import { resetLabel } from '../src/shared/usage.js';

test('a zone ICU knows is used as is, without asking Windows', () => {
  assert.equal(displayTimeZone('America/Toronto', () => { throw new Error('Windows lookup not needed'); }), 'America/Toronto');
});

test('a PC on the new British Columbia Windows zone shows times in America/Vancouver', () => {
  assert.equal(displayTimeZone(undefined, () => 'British Columbia Standard Time'), 'America/Vancouver');
  assert.equal(displayTimeZone('Etc/Unknown', () => 'British Columbia Standard Time'), 'America/Vancouver');
  // A label from the mapped zone carries the PST name the owner of that clock uses.
  assert.match(resetLabel(Date.UTC(2026, 10, 21, 3) / 1000, 'America/Vancouver'), / PST \(UTC-0[78]:00\)$/);
});

test('an unknown or unreadable Windows zone falls back to the default zone', () => {
  assert.equal(displayTimeZone(undefined, () => 'Made Up Standard Time'), undefined);
  assert.equal(displayTimeZone(undefined, () => null), undefined);
});

test('the Windows zone ID is read from reg query output', () => {
  const output = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation\r\n    TimeZoneKeyName    REG_SZ    British Columbia Standard Time\r\n\r\n';
  assert.equal(parseRegZone(output), 'British Columbia Standard Time');
  assert.equal(parseRegZone('ERROR: The system was unable to find the specified registry key or value.'), null);
});

test('only an x64 build on an ARM64 PC is the wrong download', () => {
  assert.equal(wrongBuildForPc('x64', MACHINE_ARM64), true);
  assert.equal(wrongBuildForPc('x64', MACHINE_AMD64), false);
  assert.equal(wrongBuildForPc('arm64', MACHINE_ARM64), false);
  // When Windows cannot say, the app starts rather than refusing a PC it may support.
  assert.equal(wrongBuildForPc('x64', null), false);
});
