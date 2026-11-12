import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeGuard } from '../src/services/native-guard.js';

test('a desktop call made while a message-sending call runs throws, and the guard clears afterwards', () => {
  const guard = new NativeGuard();
  guard.ready();
  // A window event raised during the native call tries another desktop call.
  assert.throws(() => guard.send(() => guard.ready()), /inside a window message/);
  assert.equal(guard.sending, false);
  guard.ready();
});

test('nested sends stay guarded until the outer one ends, also when a call throws', () => {
  const guard = new NativeGuard();
  guard.send(() => {
    guard.send(() => undefined);
    assert.equal(guard.sending, true);
    assert.throws(() => guard.ready());
  });
  assert.throws(() => guard.send(() => { throw new Error('native failure'); }), /native failure/);
  assert.equal(guard.sending, false);
  assert.equal(guard.send(() => 7), 7);
});
