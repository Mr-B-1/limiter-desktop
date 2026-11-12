import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator, type Clock } from '../src/services/scheduler.js';
import { SourceError } from '../src/providers/protocol.js';
import { parseQuota } from '../src/providers/quota.js';
const sample = () => parseQuota({ rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 2000000000 } } }, 1, 'pro', true);
class FakeClock implements Clock {
  time = 0; wallTime = 1000000; id = 0;
  timers = new Map<number, { due: number; run: () => void }>();
  now = () => this.time;
  wall = () => this.wallTime;
  set = (run: () => void, delay: number) => { const id = ++this.id; this.timers.set(id, { due: this.time + delay, run }); return id; };
  clear = (id: unknown) => { this.timers.delete(id as number); };
  async advance(ms: number): Promise<void> {
    this.time += ms; this.wallTime += ms;
    for (const [id, timer] of [...this.timers]) if (timer.due <= this.time) { this.timers.delete(id); timer.run(); }
    await new Promise(resolve => setImmediate(resolve));
  }
}
test('healthy cadence is five minutes visible and fifteen minutes hidden', async () => {
  const clock = new FakeClock(); let reads = 0;
  const coordinator = new Coordinator(async () => { reads++; return sample(); }, () => undefined, clock, () => 0);
  await coordinator.trigger('start');
  await clock.advance(299999); assert.equal(reads, 1);
  await clock.advance(1); assert.equal(reads, 2);
  coordinator.visibility(true);
  await clock.advance(899999); assert.equal(reads, 2);
  await clock.advance(1); assert.equal(reads, 3);
  await coordinator.stop();
});
test('rapid manual refreshes coalesce to one in-flight read', async () => {
  const clock = new FakeClock(); let reads = 0; let resolve!: (snapshot: ReturnType<typeof sample>) => void;
  const coordinator = new Coordinator(() => { reads++; return new Promise(done => { resolve = done; }); }, () => undefined, clock);
  const active = coordinator.trigger();
  for (let index = 0; index < 20; index++) void coordinator.trigger();
  assert.equal(reads, 1);
  resolve(sample()); await active;
  await coordinator.trigger(); assert.equal(reads, 1);
  await coordinator.stop();
});
test('notification burst yields one coalesced follow-up after cooldown', async () => {
  const clock = new FakeClock(); let reads = 0; let resolve!: (snapshot: ReturnType<typeof sample>) => void;
  const coordinator = new Coordinator(() => { reads++; return reads === 1 ? new Promise(done => { resolve = done; }) : Promise.resolve(sample()); }, () => undefined, clock, () => 0);
  const active = coordinator.trigger();
  for (let index = 0; index < 20; index++) void coordinator.trigger('hint');
  resolve(sample()); await active;
  await clock.advance(9999); assert.equal(reads, 1);
  await clock.advance(1); assert.equal(reads, 2);
  await coordinator.stop();
});
test('failure backoff rejects manual attempts until cooldown ends', async () => {
  const clock = new FakeClock(); let reads = 0;
  const coordinator = new Coordinator(async () => { reads++; throw new SourceError('offline'); }, () => undefined, clock);
  await coordinator.trigger(); assert.equal(coordinator.status, 'offline');
  await coordinator.trigger(); assert.equal(reads, 1);
  await clock.advance(30000); assert.equal(reads, 2);
  assert.equal(coordinator.cooldownMs, 60000);
  await coordinator.stop();
});
test('signed-out and compatibility states suspend automatic polling', async () => {
  for (const failure of ['signed-out', 'compatibility'] as const) {
    const clock = new FakeClock(); let reads = 0;
    const coordinator = new Coordinator(async () => { reads++; throw new SourceError(failure); }, () => undefined, clock);
    await coordinator.trigger();
    await clock.advance(3600000); assert.equal(reads, 1); assert.equal(coordinator.snapshot, null);
    await coordinator.trigger('manual'); assert.equal(reads, 2);
    await coordinator.stop();
  }
});
test('wall-clock jumps do not change sample age or monotonic cadence', async () => {
  const clock = new FakeClock();
  const coordinator = new Coordinator(async () => sample(), () => undefined, clock);
  await coordinator.trigger(); clock.wallTime += 86400000;
  assert.equal(coordinator.ageMs, 0);
  await clock.advance(10000); assert.equal(coordinator.ageMs, 10000);
  await coordinator.stop();
});
test('stale thresholds follow visibility and retain the successful read age', async () => {
  const clock = new FakeClock(); let failed = false;
  const coordinator = new Coordinator(async () => { if (failed) throw new SourceError('offline'); return sample(); }, () => undefined, clock, () => 0);
  await coordinator.trigger(); failed = true;
  await clock.advance(600000);
  assert.equal(coordinator.stale, true); assert.equal(coordinator.ageMs, 600000); assert.ok(coordinator.snapshot);
  coordinator.visibility(true); assert.equal(coordinator.stale, false);
  await clock.advance(1200000); assert.equal(coordinator.stale, true);
  await coordinator.stop();
});
test('resume refreshes once without replaying missed ticks', async () => {
  const clock = new FakeClock(); let reads = 0;
  const coordinator = new Coordinator(async () => { reads++; return sample(); }, () => undefined, clock);
  await coordinator.trigger(); coordinator.suspend();
  await clock.advance(3600000); assert.equal(reads, 1);
  coordinator.resume(); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 2);
  await coordinator.stop();
});
test('a passed reset causes one attempt, not an invented zero or a tight loop', async () => {
  const clock = new FakeClock(); let reads = 0;
  const quota = sample(); quota.windows[0].resetsAt = 1020;
  const coordinator = new Coordinator(async () => { reads++; return quota; }, () => undefined, clock, () => 0);
  await coordinator.trigger(); await clock.advance(20000);
  coordinator.checkResets(); await new Promise(resolve => setImmediate(resolve));
  coordinator.checkResets(); assert.equal(reads, 2); assert.equal(coordinator.snapshot?.windows[0].usedPercent, 12);
  await coordinator.stop();
});
test('stopping clears timers and prevents future reads', async () => {
  const clock = new FakeClock(); let reads = 0;
  const coordinator = new Coordinator(async () => { reads++; return sample(); }, () => undefined, clock);
  await coordinator.trigger(); await coordinator.stop();
  await clock.advance(3600000); await coordinator.trigger();
  assert.equal(clock.timers.size, 0); assert.equal(reads, 1);
});

test('idle source compatibility faults reach the UI and cancel automatic polling', async () => {
  const clock = new FakeClock(); let reads = 0;
  const coordinator = new Coordinator(async () => { reads++; return sample(); }, () => undefined, clock);
  await coordinator.trigger();
  coordinator.invalidate();
  coordinator.reportFailure(new SourceError('compatibility'));
  assert.equal(coordinator.status, 'compatibility');
  assert.equal(coordinator.snapshot, null);
  assert.equal(clock.timers.size, 0);
  await clock.advance(3600000);
  assert.equal(reads, 1);
  await coordinator.stop();
});

test('a terminal source fault wins a same-tick successful or changed read', async () => {
  for (const mode of ['success', 'changed']) {
    const clock = new FakeClock(); let finish!: () => void;
    const coordinator = new Coordinator(() => new Promise((resolve, reject) => {
      finish = () => mode === 'success' ? resolve(sample()) : reject(new SourceError('changed'));
    }), () => undefined, clock);
    const pending = coordinator.trigger();
    coordinator.reportFailure(new SourceError('compatibility'));
    finish(); await pending;
    assert.equal(coordinator.status, 'compatibility');
    assert.equal(coordinator.snapshot, null);
    assert.equal(clock.timers.size, 0);
    await coordinator.stop();
  }
});
