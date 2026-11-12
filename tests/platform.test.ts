import test from 'node:test';
import assert from 'node:assert/strict';
import { MACHINE_AMD64, MACHINE_ARM64, wrongBuildForPc } from '../src/shared/platform.js';

test('only an x64 build on an ARM64 PC is the wrong download', () => {
  assert.equal(wrongBuildForPc('x64', MACHINE_ARM64), true);
  assert.equal(wrongBuildForPc('x64', MACHINE_AMD64), false);
  assert.equal(wrongBuildForPc('arm64', MACHINE_ARM64), false);
  // When Windows cannot say, the app starts rather than refusing a PC it may support.
  assert.equal(wrongBuildForPc('x64', null), false);
});
