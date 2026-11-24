import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { NativeGuard } from '../src/services/native-guard.js';

const source = ts.createSourceFile('main.ts', readFileSync(path.join(process.cwd(), 'src/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'smokeFocus');
assert.ok(declaration, 'The production smoke must use the bounded focus observer');
const compiled = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
type Identity = { handle: string; root: string; pid: number; windowClass: string; rootClass: string; alive: boolean; visible: boolean; topmost: boolean; normal: boolean; ownProcess: boolean };
type Sample = { phase: string; elapsedMs: number; foreground: string; foregroundIdentity: Identity; referenceMatches: boolean; referenceAlive: boolean; referenceVisible: boolean; referenceTopmost: boolean; widgetAttached: boolean; widgetTopmost: boolean; widgetFocused: boolean };
type Result = { result: 'PASS' | 'FAIL' | 'UNVERIFIED'; reason: string | null; actionRan: boolean; referenceKind: string; referenceIdentity: Identity; observationScope: string; sampleIntervalMs: number; widgetFocusEvents: number; referenceBlurEvents: number | null; samples: Sample[] };

class FakeWindow extends EventEmitter {
  alive = true;
  visible = true;
  topmost = false;
  focused = false;
  constructor(readonly handle: bigint) { super(); }
  isDestroyed() { return !this.alive; }
  isVisible() { return this.visible; }
  isAlwaysOnTop() { return this.topmost; }
  isFocused() { return this.focused; }
  getNativeWindowHandle() { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(this.handle); return buffer; }
}

function harness() {
  const widget = new FakeWindow(1n), reference = new FakeWindow(4n);
  const owned = new Map<string, FakeWindow>([['1', widget], ['4', reference]]), overrides = new Map<string, Partial<Identity>>();
  const intervals = new Map<number, () => void>();
  let foreground = '4', attached = true, topmost = false, now = 0, sequence = 0, inNativeEvent = false, failRead = false;
  const nativeRead = () => {
    assert.equal(inNativeEvent, false, 'Focus event callbacks must never re-enter native calls');
    if (failRead) { failRead = false; throw new Error('controlled native observation failure'); }
  };
  const context = vm.createContext({ Error, window: widget, desktop: {
    inspect: () => { nativeRead(); return { attached, topmost }; }, foreground: () => { nativeRead(); return foreground; },
    inspectForeground: () => {
      nativeRead(); const owner = owned.get(foreground), alive = foreground !== 'null' && (!owner || owner.alive);
      const visible = alive && (!owner || owner.visible), topmost = owner?.topmost ?? false;
      return { handle: foreground, root: foreground, pid: alive ? (owner ? 100 : 200) : 0, windowClass: 'NormalWindow', rootClass: 'NormalWindow',
        alive, visible, topmost, normal: visible && !topmost, ownProcess: Boolean(owner), ...overrides.get(foreground) };
    }
  }, performance: { now: () => now },
  setTimeout: (run: () => void, delay: number) => { queueMicrotask(() => { now += delay; [...intervals.values()].forEach(callback => callback()); run(); }); return ++sequence; },
  setInterval: (run: () => void) => { const id = ++sequence; intervals.set(id, run); return id; },
  clearInterval: (id: number) => intervals.delete(id) });
  vm.runInContext(compiled + '\nglobalThis.check=smokeFocus;', context);
  const observe = context.check as (reference: FakeWindow, action: () => void | Promise<void>) => Promise<Result>;
  const check = (reference: FakeWindow, action: () => void | Promise<void>) => { owned.set(String(reference.handle), reference); return observe(reference, action); };
  return { widget, reference, check, setForeground: (next: string) => { foreground = next; }, detach: () => { attached = false; }, makeTopmost: () => { topmost = true; },
    intervals, focusDuringNative: () => { inNativeEvent = true; widget.emit('focus'); inNativeEvent = false; },
    failIntervalRead: () => { failRead = true; [...intervals.values()].forEach(callback => callback()); },
    externalIdentity: (handle: string, identity: Partial<Identity>) => { overrides.set(handle, identity); } };
}

test('focus smoke records a live reference, immediate native predicates and a 250 ms post-action observation', async () => {
  const app = harness();
  const result = await app.check(app.reference, () => {});
  assert.equal(result.result, 'PASS'); assert.equal(result.actionRan, true);
  assert.equal(result.referenceKind, 'controlled'); assert.equal(result.referenceBlurEvents, 0);
  const immediate = result.samples.find(sample => sample.phase === 'immediate');
  const settled = result.samples.filter(sample => sample.phase === 'settled');
  assert.ok(immediate); assert.ok(settled.at(-1)!.elapsedMs - immediate.elapsedMs >= 250);
  assert.ok(result.samples.every(sample => sample.referenceAlive && sample.referenceVisible && !sample.referenceTopmost && sample.foreground === '4' && sample.widgetAttached && !sample.widgetTopmost));
  assert.equal(app.intervals.size, 0); assert.equal(app.widget.listenerCount('focus'), 0); assert.equal(app.reference.listenerCount('blur'), 0);
});

test('unrelated foreground changes between independently measured actions do not cause a false focus failure', async () => {
  const app = harness();
  assert.equal((await app.check(app.reference, () => {})).result, 'PASS');
  const other = new FakeWindow(5n); app.setForeground('5');
  assert.equal((await app.check(other, () => {})).result, 'PASS');
});

test('a stable normal external foreground is a valid reference when the controlled cover cannot acquire focus', async () => {
  const app = harness(); app.setForeground('5'); let ran = false;
  const result = await app.check(app.reference, () => { ran = true; });
  assert.equal(result.result, 'PASS'); assert.equal(ran, true);
  assert.equal(result.referenceKind, 'ambient'); assert.equal(result.referenceBlurEvents, null); assert.equal(result.sampleIntervalMs, 20);
  assert.equal(result.referenceIdentity.pid, 200); assert.ok(result.samples.every(sample => sample.referenceMatches && sample.foregroundIdentity.pid === 200));
  assert.match(result.observationScope, /external transitions between samples are not observed/);
  assert.equal(app.reference.listenerCount('blur'), 0);
});

test('an unavailable or unstable foreground baseline is inconclusive and never runs the action', async t => {
  for (const scenario of ['null foreground', 'destroyed reference', 'hidden reference', 'topmost reference', 'controller foreground', 'detached widget']) {
    await t.test(scenario, async () => {
      const app = harness(); let ran = false;
      if (scenario === 'null foreground') app.setForeground('null');
      if (scenario === 'destroyed reference') app.reference.alive = false;
      if (scenario === 'hidden reference') app.reference.visible = false;
      if (scenario === 'topmost reference') app.reference.topmost = true;
      if (scenario === 'controller foreground') { app.externalIdentity('5', { normal: false, windowClass: 'LimiterFocusVerification1' }); app.setForeground('5'); }
      if (scenario === 'detached widget') app.detach();
      const result = await app.check(app.reference, () => { ran = true; });
      assert.equal(result.result, 'UNVERIFIED'); assert.equal(result.actionRan, false); assert.equal(ran, false);
    });
  }
});

test('a transient widget focus event fails even when every sampled foreground returns to the reference', async () => {
  const app = harness();
  const result = await app.check(app.reference, app.focusDuringNative);
  assert.equal(result.result, 'FAIL'); assert.equal(result.widgetFocusEvents, 1);
  assert.ok(result.samples.every(sample => sample.foreground === '4'));
  assert.match(result.reason!, /widget took focus/);
});

test('the native foreground or child focus predicate detects widget activation without an Electron focus event', async t => {
  for (const scenario of ['foreground', 'child focus']) await t.test(scenario, async () => {
    const app = harness();
    const result = await app.check(app.reference, () => { if (scenario === 'foreground') app.setForeground('1'); else app.widget.focused = true; });
    assert.equal(result.result, 'FAIL'); assert.match(result.reason!, /widget took focus/);
  });
});

test('foreign interference during an action is inconclusive and keeps the separate native predicates', async () => {
  const app = harness();
  const result = await app.check(app.reference, () => { app.setForeground('5'); });
  assert.equal(result.result, 'UNVERIFIED'); assert.match(result.reason!, /inconclusive/);
  assert.equal(result.widgetFocusEvents, 0);
  assert.equal(result.samples.find(sample => sample.phase === 'immediate')?.foreground, '5');
  assert.ok(result.samples.every(sample => sample.widgetAttached && !sample.widgetTopmost));
});

test('transient reference blur remains inconclusive even when endpoints match', async () => {
  const app = harness();
  const result = await app.check(app.reference, () => { app.reference.emit('blur'); });
  assert.equal(result.result, 'UNVERIFIED'); assert.equal(result.referenceBlurEvents, 1);
  assert.ok(result.samples.every(sample => sample.foreground === '4'));
});

test('attachment loss and topmost changes fail independently of foreground equality', async t => {
  for (const scenario of ['detach', 'topmost']) await t.test(scenario, async () => {
    const app = harness();
    const result = await app.check(app.reference, scenario === 'detach' ? app.detach : app.makeTopmost);
    assert.equal(result.result, 'FAIL'); assert.match(result.reason!, /desktop layer/);
    assert.ok(result.samples.every(sample => sample.foreground === '4'));
  });
});

test('a failed action retains its observations and removes focus listeners and sampling timers', async () => {
  const app = harness();
  const result = await app.check(app.reference, () => { throw new Error('controlled action failure'); });
  assert.equal(result.result, 'FAIL'); assert.match(result.reason!, /controlled action failure/); assert.ok(result.samples.length);
  assert.equal(app.intervals.size, 0); assert.equal(app.widget.listenerCount('focus'), 0); assert.equal(app.reference.listenerCount('blur'), 0);
});

test('a native interval observation failure is retained as failure even if later observations recover', async () => {
  const app = harness();
  const result = await app.check(app.reference, app.failIntervalRead);
  assert.equal(result.result, 'FAIL'); assert.match(result.reason!, /controlled native observation failure/);
  assert.ok(result.samples.some(sample => sample.phase === 'settled'));
  assert.equal(app.intervals.size, 0); assert.equal(app.widget.listenerCount('focus'), 0);
});

test('ambient reference identity changes remain inconclusive instead of switching references during the action', async t => {
  for (const [field, value] of Object.entries({ handle: '6', root: '6', pid: 201, windowClass: 'ChangedWindow', rootClass: 'ChangedRoot' })) {
    await t.test(field, async () => {
      const app = harness(); app.setForeground('5');
      const result = await app.check(app.reference, () => { app.externalIdentity('5', { [field]: value }); });
      assert.equal(result.result, 'UNVERIFIED'); assert.equal(result.referenceIdentity.pid, 200);
      assert.ok(result.samples.some(sample => !sample.referenceMatches));
    });
  }
});

test('ambient null, hidden, topmost, unknown, controller and own-process references never authorize an action', async t => {
  const invalid: Record<string, Partial<Identity>> = { dead: { alive: false }, hidden: { visible: false }, topmost: { topmost: true },
    unknown: { pid: 0, normal: false }, desktop: { windowClass: 'Progman', normal: false }, controller: { windowClass: 'LimiterAmbientFocusControl1', normal: false },
    'own process': { pid: 100, ownProcess: true } };
  for (const [name, value] of Object.entries(invalid)) await t.test(name, async () => {
    const app = harness(); app.setForeground('5'); app.externalIdentity('5', value); let ran = false;
    const result = await app.check(app.reference, () => { ran = true; });
    assert.equal(result.result, 'UNVERIFIED'); assert.equal(ran, false); assert.equal(result.referenceBlurEvents, null);
  });
});

test('the widget focus event observer stays active for ambient references and catches a transient steal', async () => {
  const app = harness(); app.setForeground('5');
  const result = await app.check(app.reference, app.focusDuringNative);
  assert.equal(result.result, 'FAIL'); assert.equal(result.widgetFocusEvents, 1); assert.equal(result.referenceBlurEvents, null);
  assert.ok(result.samples.every(sample => sample.foreground === '5'));
});

test('production foreground inspection records native identity and rejects unsafe or unknown reference windows', () => {
  const text = readFileSync(path.join(process.cwd(), 'src/services/desktop.ts'), 'utf8');
  const source = ts.createSourceFile('desktop.ts', text, ts.ScriptTarget.Latest, true);
  const surface = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'DesktopSurface') as ts.ClassDeclaration;
  const method = surface.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === 'inspectForeground'); assert.ok(method);
  const code = ts.transpileModule('class Probe {' + method.getText(source) + '} globalThis.probe=new Probe();', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const guard = new NativeGuard();
  const state = { handle: 5n as bigint | null, root: 5n, pid: 200, alive: true, visible: true, style: 0, extendedStyle: 0, windowClass: 'NormalWindow', rootClass: 'NormalWindow' };
  const baseline = { ...state };
  const context = vm.createContext({ process: { pid: 100 }, ready: () => guard.ready(),
    user: { func: (signature: string) => { assert.equal(signature, 'uint __stdcall GetWindowThreadProcessId(void*, _Out_ uint*)'); return (_handle: bigint, output: number[]) => { output[0] = state.pid; return state.pid ? 1 : 0; }; } },
    getForegroundWindow: () => state.handle, getAncestor: () => state.root, isWindow: () => state.alive ? 1 : 0, isVisible: () => state.visible ? 1 : 0,
    getStyle: (_handle: bigint, index: number) => index === -16 ? state.style : state.extendedStyle,
    className: (handle: bigint) => handle === state.handle ? state.windowClass : state.rootClass
  });
  vm.runInContext(code, context);
  const inspect = () => (context.probe as { inspectForeground(): Identity }).inspectForeground();
  assert.deepEqual(JSON.parse(JSON.stringify(inspect())), { handle: '5', root: '5', pid: 200, windowClass: 'NormalWindow', rootClass: 'NormalWindow', alive: true, visible: true, topmost: false, normal: true, ownProcess: false });
  const invalid = [{ handle: null }, { alive: false }, { visible: false }, { extendedStyle: 8 }, { style: 0x40000000 }, { pid: 0 },
    { root: 6n }, { windowClass: '' }, { windowClass: 'Progman' }, { windowClass: 'Shell_TrayWnd' },
    { windowClass: 'LimiterFocusVerification1' }, { windowClass: 'LimiterAmbientFocusControl1' }];
  for (const change of invalid) { Object.assign(state, baseline, change); assert.equal(inspect().normal, false); }
  Object.assign(state, baseline, { pid: 100 }); assert.equal(inspect().ownProcess, true);
  assert.throws(() => guard.send(inspect), /inside a window message/);
});
