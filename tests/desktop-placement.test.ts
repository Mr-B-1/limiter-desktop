import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { NativeGuard } from '../src/services/native-guard.js';
import { clampBounds, defaults, parsePreferences, PreferenceStore, type Bounds, type Preferences } from '../src/services/store.js';
import { COMPACT_SIZE } from '../src/services/store.js';
import { MAX_WIDGET_SIZE, resizeBounds, resizeEdges } from '../src/services/resize.js';

const mainSource = ts.createSourceFile('main.ts', readFileSync(path.join(process.cwd(), 'src/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const desktopSource = readFileSync(path.join(process.cwd(), 'src/services/desktop.ts'), 'utf8');
function declaration(name: string): string {
  return mainSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(mainSource) || '';
}
function expression(predicate: (node: ts.Node) => boolean): string {
  let found = '';
  const visit = (node: ts.Node) => { if (predicate(node)) found = node.getText(mainSource); ts.forEachChild(node, visit); };
  visit(mainSource); assert.ok(found); return found;
}
function calls(name: string): string {
  const found: string[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(mainSource) === name) found.push(node.getText(mainSource) + ';'); ts.forEachChild(node, visit); };
  visit(mainSource); return found.join('\n');
}
const resizeHandler = expression(node => ts.isCallExpression(node) && node.expression.getText(mainSource) === 'handle' && node.arguments[0]?.getText(mainSource) === "'limiter:resize'");
const displayClamp = expression(node => ts.isVariableDeclaration(node) && node.name.getText(mainSource) === 'clamp');
const retryTick = expression(node => ts.isBinaryExpression(node) && node.left.getText(mainSource) === 'tick' && ts.isCallExpression(node.right));
type Display = { id: number; bounds: Bounds; workArea: Bounds; scaleFactor: number; rotation: number; nativeOrigin: { x: number; y: number } };
type Placement = { bounds: Bounds; native: Bounds; layout: string };
type Surface = { bounds(): Bounds; occlusionReceipt(other: unknown): Record<string, unknown>; attached: boolean };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const display = (scaleFactor = 1.5, x = 0, y = 0, nativeX = 0, nativeY = 0, id = 1): Display => ({
  id, scaleFactor, rotation: 0, bounds: { x, y, width: 1600, height: 1000 }, workArea: { x, y, width: 1600, height: 960 }, nativeOrigin: { x: nativeX, y: nativeY }
});

// The real production class runs against synthetic Win32 calls. Conversion deliberately encloses fractional edges,
// so a lossy logical round trip cannot accidentally pass. Actual Electron/Win32 behavior needs the native receipt.
async function harness(preferences: Preferences, displays: Display[], directory?: string) {
  const root = directory || await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-placement-test-'));
  const store = new PreferenceStore(root);
  const timers = new Map<number, () => void>();
  let timer = 0, raw: Bounds = { x: 0, y: 0, width: 1, height: 1 }, parent = 0n, style = 0, closed = false, positions = 0, writes = 0;
  let retry = () => {};
  const save = store.save.bind(store);
  store.save = preferences => { writes++; return save(preferences); };
  const powerEvents = new Map<string, (() => void)[]>(), displayEvents = new Map<string, (() => void)[]>();
  const listen = (events: Map<string, (() => void)[]>, name: string, run: () => void) => { events.set(name, [...(events.get(name) || []), run]); };
  const windows: FakeWindow[] = [];
  const currentWindow = () => windows[windows.length - 1];
  const parentOrigin = { x: -371, y: 29 };
  const match = (rect: Bounds, native: boolean) => displays.find(item => {
    const origin = native ? item.nativeOrigin : item.bounds;
    const scale = native ? item.scaleFactor : 1;
    return rect.x + rect.width / 2 >= origin.x && rect.x + rect.width / 2 < origin.x + item.bounds.width * scale &&
      rect.y + rect.height / 2 >= origin.y && rect.y + rect.height / 2 < origin.y + item.bounds.height * scale;
  }) || displays[0];
  const convert = (rect: Bounds, native: boolean): Bounds => {
    const selected = match(rect, native), scale = native ? 1 / selected.scaleFactor : selected.scaleFactor;
    const from = native ? selected.nativeOrigin : selected.bounds, to = native ? selected.bounds : selected.nativeOrigin;
    const x = Math.floor(to.x + (rect.x - from.x) * scale), y = Math.floor(to.y + (rect.y - from.y) * scale);
    return { x, y, width: Math.ceil(to.x + (rect.x + rect.width - from.x) * scale) - x, height: Math.ceil(to.y + (rect.y + rect.height - from.y) * scale) - y };
  };
  const screen = { getAllDisplays: () => displays, getDisplayMatching: (rect: Bounds) => match(rect, false),
    on: (name: string, run: () => void) => listen(displayEvents, name, run),
    dipToScreenRect: (_window: unknown, rect: Bounds) => convert(rect, false), screenToDipRect: (_window: unknown, rect: Bounds) => convert(rect, true) };
  class FakeWindow {
    events = new Map<string, (...args: unknown[]) => void>();
    visible = false;
    webContents = { setWindowOpenHandler: () => {}, on: () => {} };
    constructor(bounds: Bounds) { windows.push(this); raw = convert(bounds, false); }
    getNativeWindowHandle() { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(1n); return buffer; }
    setAlwaysOnTop() {} setSkipTaskbar() {} hide() { this.visible = false; } showInactive() { this.visible = true; }
    isDestroyed() { return false; } isVisible() { return this.visible; }
    on(event: string, run: (...args: unknown[]) => void) { this.events.set(event, run); }
    async loadURL() {}
  }
  const native: Record<string, (...args: never[]) => unknown> = {
    FindWindowExW: () => 3n, EnumWindows: (callback: (handle: bigint) => number) => callback(2n),
    GetParent: () => parent, GetAncestor: (handle: bigint) => handle === 1n ? 2n : handle,
    SetParent: (_handle: bigint, next: bigint) => { parent = next; return 0n; },
    GetWindowLongPtrW: (_handle: bigint, index: number) => index === -16 ? style : 0,
    SetWindowLongPtrW: (_handle: bigint, _index: number, next: bigint) => { style = Number(next); return 0n; },
    SetWindowPos: (_handle: bigint, _after: bigint, x: number, y: number, width: number, height: number, flags: number) => {
      positions++;
      if (!(flags & 0x2)) { raw.x = x + parentOrigin.x; raw.y = y + parentOrigin.y; currentWindow().events.get('move')?.(); }
      if (!(flags & 0x1)) { raw.width = width; raw.height = height; currentWindow().events.get('resize')?.(); }
      return 1;
    },
    IsWindow: () => 1, IsWindowVisible: () => 1,
    GetClassNameW: (handle: bigint, buffer: Buffer) => { buffer.write(handle === 2n ? 'Progman\0' : handle === 3n ? 'SHELLDLL_DefView\0' : 'Application\0', 'utf16le'); return 1; },
    GetWindowRect: (_handle: bigint, rect: { left: number; top: number; right: number; bottom: number }) => { Object.assign(rect, { left: raw.x, top: raw.y, right: raw.x + raw.width, bottom: raw.y + raw.height }); return 1; },
    ScreenToClient: (_handle: bigint, point: { x: number; y: number }) => { point.x -= parentOrigin.x; point.y -= parentOrigin.y; return 1; },
    WindowFromPoint: () => 4n, GetForegroundWindow: () => 4n
  };
  const koffi = { proto: () => {}, struct: () => {}, load: () => ({ func: (signature: string) => {
    const name = /__stdcall (\w+)/.exec(signature)?.[1]; assert.ok(name && native[name], signature); return native[name];
  } }) };
  const module = { exports: {} as { DesktopSurface: new (window: FakeWindow) => Surface } };
  const context = vm.createContext({ Buffer, exports: module.exports, module, require: (name: string) => {
    if (name === 'electron') return { screen };
    if (name === 'koffi') return koffi;
    if (name === './native-guard.js') return { NativeGuard };
    if (name === './resize.js') return { MAX_WIDGET_SIZE };
    throw new Error('Unexpected desktop import: ' + name);
  } });
  vm.runInContext(ts.transpileModule(desktopSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText, context);
  const bindings = vm.createContext({ preferences, store, screen, path, clampBounds, COMPACT_SIZE, resizeBounds, resizeEdges,
    app: { getAppPath: () => '.', quit: () => { closed = true; } }, BrowserWindow: FakeWindow, DesktopSurface: module.exports.DesktopSurface,
    window: null, desktop: null, hiddenByUser: false, resizeOrigin: null, quitting: false, shutdown: null, saveTimer: undefined, recreateTimer: undefined,
    settingsNotice: null, tick: undefined, slowTick: undefined, codexTimer: undefined, provider: undefined,
    manualGeometryActive: false, manualBoundsPending: false, geometrySuspended: false, geometryLocked: false, geometryTimer: undefined,
    powerMonitor: { on: (name: string, run: () => void) => listen(powerEvents, name, run) },
    gate: { paused: false, tick: () => {}, lock: () => {}, unlock: () => {} },
    coordinator: { visibility: () => {}, stop: async () => {}, checkResets: () => {}, suspend: () => {}, resume: () => {} }, claude: undefined, modReader: undefined, estimator: undefined, grok: undefined, antigravity: undefined, storage: undefined,
    launchWrites: Promise.resolve(), tray: null, shutdownReceipt: null, send: () => {},
    setTimeout: (run: () => void) => { timers.set(++timer, run); return timer; }, clearTimeout: (id: number) => timers.delete(id), clearInterval: () => {},
    setInterval: (run: () => void) => { retry = run; return 1; }
  });
  const code = ['rememberBounds', 'restoreGeometry', 'queueGeometry', 'beginManualGeometry', 'finishManualGeometry', 'pauseGeometry', 'suspendGeometry', 'resumeGeometry', 'lockGeometry', 'unlockGeometry', 'persist', 'show', 'hide', 'quit', 'createWidget'].map(declaration).join('\n') +
    `\nlet resize; const handle=(_channel,action)=>{resize=action}; ${resizeHandler}; const ${displayClamp}; ${calls('screen.on')} ${calls('powerMonitor.on')} ${retryTick}; globalThis.api={createWidget,show,hide,quit,resize,clamp,preferences:()=>preferences,surface:()=>desktop,notice:()=>settingsNotice};`;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, bindings);
  const api = bindings.api as { createWidget(): Promise<void>; show(): void; hide(): void; quit(): Promise<void>; resize(value: unknown): void; clamp(): void; preferences(): Preferences; surface(): Surface; notice(): string | null };
  await api.createWidget();
  const flush = async () => {
    for (let turns = 0; timers.size; turns++) {
      assert.ok(turns < 30, 'native geometry must reach quiescence, not schedule an endless restoration loop');
      const pending = [...timers.values()]; timers.clear(); pending.forEach(run => run()); await Promise.resolve(); await store.flush();
    }
  };
  await flush();
  return { ...api, root, store, flush, screen, closed: () => closed, raw: () => copy(raw), pending: () => timers.size, positions: () => positions, writes: () => writes,
    external: (rect: Bounds, manual = true, finish = true) => {
      if (manual) currentWindow().events.get('will-move')?.({}, rect);
      raw = copy(rect); currentWindow().events.get('move')?.(); currentWindow().events.get('resize')?.();
      if (manual && finish) currentWindow().events.get('moved')?.();
    },
    finishGesture: () => currentWindow().events.get('moved')?.(),
    power: (name: string) => powerEvents.get(name)?.forEach(run => run()), displayEvent: (name: string) => displayEvents.get(name)?.forEach(run => run()),
    detach: () => { parent = 0n; }, retry: () => retry(), destroy: () => currentWindow().events.get('closed')?.() };
}

test('native drag and resize survive disk reload into fresh surfaces at fractional scales and mixed monitor origins', async () => {
  for (const scale of [1.25, 1.5, 1.75]) {
    const displays = [display(1), display(scale, -1600, -200, -2800, -375, 2)];
    let app = await harness({ ...defaults(), bounds: { x: -1403, y: -101, width: 375, height: 491 } }, displays);
    const expected = { ...app.raw(), x: app.raw().x + 1, y: app.raw().y + 3, width: app.raw().width + 1, height: app.raw().height - 1 };
    app.external(expected); await app.flush();
    const logical = app.preferences().bounds;
    for (let restart = 0; restart < 5; restart++) {
      const saved = await new PreferenceStore(app.root).load();
      app = await harness(saved, displays, app.root);
      assert.deepEqual(app.raw(), expected, `physical rectangle drifted at ${scale} scale on restart ${restart + 1}`);
      assert.deepEqual(app.preferences().bounds, logical, 'saved logical bounds also remain stable');
    }
  }
});

test('Show and quit capture final external movement even before the debounce save runs', async () => {
  const displays = [display()];
  let app = await harness({ ...defaults(), bounds: { x: 71, y: 83, width: 375, height: 491 } }, displays);
  const expected = { ...app.raw(), x: app.raw().x + 7, y: app.raw().y + 5, width: app.raw().width - 1 };
  app.external(expected); assert.ok(app.pending()); app.hide(); app.show();
  assert.deepEqual(app.raw(), expected, 'Show must not reapply the stale pre-drag preference');
  const last = { ...expected, x: expected.x + 5, height: expected.height - 1 };
  app.external(last); await app.quit(); assert.equal(app.closed(), true); assert.equal(app.pending(), 0);
  app = await harness(await new PreferenceStore(app.root).load(), displays, app.root);
  assert.deepEqual(app.raw(), last, 'quit supersedes the pending debounce and saves the final native rectangle');
});

test('resize IPC captures both geometries and a cold start retains its exact native result', async () => {
  const displays = [display(1.75)];
  let app = await harness({ ...defaults(), bounds: { x: 73, y: 81, width: 375, height: 491 } }, displays);
  app.resize({ phase: 'start', edge: 'se' }); app.resize({ phase: 'move', dx: 17, dy: 23 });
  const expected = app.raw(); app.resize({ phase: 'end' }); await app.store.flush();
  app = await harness(await new PreferenceStore(app.root).load(), displays, app.root);
  assert.deepEqual(app.raw(), expected);
});

test('maximum width and height save successfully and retain exact pixels at fractional display scales', async context => {
  for (const scale of [1.25, 1.5, 1.75]) for (const dimension of ['width', 'height'] as const) await context.test(`${dimension} at ${scale}`, async () => {
    const area = { x: -2200, y: -200, width: 2200, height: 1800 };
    const displays = [{ ...display(scale, area.x, area.y, -3001, -351, 2), bounds: area, workArea: { ...area, height: 1760 } }];
    for (let offset = 0; offset < 4; offset++) {
      let app = await harness({ ...defaults(), bounds: { x: -2109 + offset, y: -111 + offset, width: 375, height: 491 } }, displays);
      app.external({ ...app.raw(), x: app.raw().x + 1, y: app.raw().y + 1 });
      app.resize({ phase: 'start', edge: dimension === 'width' ? 'e' : 's' });
      app.resize({ phase: 'move', dx: dimension === 'width' ? 2000 : 0, dy: dimension === 'height' ? 2000 : 0 });
      const expected = app.raw();
      app.resize({ phase: 'end' }); await app.flush();
      assert.equal(app.notice(), null, `maximum size must save at native origin offset ${offset}`);
      const saved = await new PreferenceStore(app.root).load();
      assert.deepEqual(saved.bounds, copy(app.preferences().bounds), 'the maximum resize must reach the settings file');
      assert.equal(saved.bounds![dimension], MAX_WIDGET_SIZE[dimension]);
      const converted = app.screen.screenToDipRect(null, expected);
      assert.equal(saved.bounds!.x, converted.x, 'position must not be normalized with dimensions');
      assert.equal(saved.bounds!.y, converted.y, 'position must not be normalized with dimensions');
      app = await harness(saved, displays, app.root);
      assert.deepEqual(app.raw(), expected, 'maximum native geometry must survive a cold start');
    }
  });
});

test('maximum-size normalization never accepts oversized preferences or native sizes beyond two DIP', async () => {
  for (const dimension of ['width', 'height'] as const) for (const excess of [1, 2, 3, 100]) {
    assert.throws(() => parsePreferences({ ...defaults(), bounds: { x: 31, y: 43, ...MAX_WIDGET_SIZE, [dimension]: MAX_WIDGET_SIZE[dimension] + excess } }), /Invalid bounds/);
  }
  for (const dimension of ['width', 'height'] as const) {
    const area = { x: 0, y: 0, width: 2400, height: 1800 };
    const app = await harness({ ...defaults(), bounds: { x: 31, y: 43, width: 375, height: 491 } }, [{ ...display(), bounds: area, workArea: area }]);
    const oversized = app.screen.dipToScreenRect(null, { x: 31, y: 43, ...MAX_WIDGET_SIZE, [dimension]: MAX_WIDGET_SIZE[dimension] + 3 });
    app.external(oversized);
    const converted = app.screen.screenToDipRect(null, oversized);
    assert.equal(app.surface().bounds()[dimension], converted[dimension], 'oversize beyond the margin remains invalid');
    await app.flush(); assert.match(app.notice() || '', /could not be saved/);
    assert.deepEqual(app.raw(), oversized, 'validation must never silently change the physical rectangle');
  }
});

test('display changes and clamping invalidate native restoration while unchanged layouts retain it', async () => {
  const displays = [display(1.25, -1600, 0, -2000, 0, 2), display(1.5)];
  const app = await harness({ ...defaults(), bounds: { x: -1401, y: 51, width: 375, height: 491 } }, displays);
  const before = { ...app.raw(), x: app.raw().x + 1, width: app.raw().width - 1 };
  app.external(before); await app.flush();
  const saved = await new PreferenceStore(app.root).load();
  for (const changed of [[display(1.5)], [display(1.75, -1600, 0, -2800, 0, 2), display(1.5)], [display(1.25, -1600, 0, -2000, 0, 2), { ...display(1.5), workArea: { x: 0, y: 40, width: 1600, height: 900 } }]]) {
    const restored = await harness(copy(saved), changed);
    const clamped = clampBounds(saved.bounds, changed.map(item => item.workArea));
    assert.deepEqual(restored.raw(), restored.screen.dipToScreenRect(null, clamped));
  }
  const outside = { x: 8000, y: 8000, width: 375, height: 491 };
  const clamped = await harness({ ...copy(saved), bounds: outside }, displays);
  assert.deepEqual(clamped.raw(), clamped.screen.dipToScreenRect(null, clampBounds(outside, displays.map(item => item.workArea))));
});

test('native placement validation preserves other settings and settings parsing retains valid placement', async () => {
  const app = await harness({ ...defaults(), theme: 'dark', bounds: { x: 31, y: 43, width: 375, height: 491 } }, [display()]);
  const saved = await new PreferenceStore(app.root).load();
  const placement = (saved as Preferences & { nativePlacement?: Placement }).nativePlacement;
  assert.ok(placement, 'disk persistence must retain the optional native rectangle');
  assert.deepEqual((parsePreferences({ ...saved, localDiskLabel: 'Desk' }) as Preferences & { nativePlacement?: Placement }).nativePlacement, placement);
  for (const broken of ['invalid', {}, { ...placement, native: { ...placement.native, width: -1 } }, { ...placement, native: { ...placement.native, x: Infinity } }, { ...placement, layout: '' }, { ...placement, bounds: { ...placement.bounds, x: placement.bounds.x + 1 } }]) {
    const parsed = parsePreferences({ ...saved, nativePlacement: broken });
    assert.equal((parsed as Preferences & { nativePlacement?: Placement }).nativePlacement, undefined);
    assert.equal(parsed.theme, 'dark'); assert.deepEqual(parsed.bounds, saved.bounds);
  }
});

test('structurally valid but inconsistent native rectangles never bypass logical work-area clamping', async () => {
  const displays = [display()];
  const app = await harness({ ...defaults(), bounds: { x: 31, y: 43, width: 375, height: 491 } }, displays);
  const saved = await new PreferenceStore(app.root).load();
  const placement = (saved as Preferences & { nativePlacement?: Placement }).nativePlacement;
  assert.ok(placement);
  for (const changed of [
    { ...saved, nativePlacement: { ...placement, native: { ...placement.native, x: 40000, y: 40000 } } },
    { ...saved, bounds: { ...saved.bounds!, x: saved.bounds!.x + 53 } }
  ]) {
    const restored = await harness(parsePreferences(changed), displays);
    assert.deepEqual(restored.raw(), restored.screen.dipToScreenRect(null, clampBounds(changed.bounds, displays.map(item => item.workArea))));
  }
});

test('deferred display handling, Explorer reattachment and window recreation retain exact native placement', async () => {
  const displays = [display(1.5)];
  const app = await harness({ ...defaults(), bounds: { x: 131, y: 143, width: 375, height: 491 } }, displays);
  const expected = { ...app.raw(), x: app.raw().x + 1, height: app.raw().height - 1 };
  app.external(expected); await app.flush();
  app.clamp(); assert.deepEqual(app.raw(), expected, 'the display event only schedules native work'); await app.flush();
  assert.deepEqual(app.raw(), expected, 'unchanged display notifications must not round-trip the rectangle');
  app.detach(); app.retry(); assert.deepEqual(app.raw(), expected); await app.flush();
  app.destroy(); await app.flush(); await app.flush();
  assert.deepEqual(app.raw(), expected, 'a new BrowserWindow and DesktopSurface restore the saved pixels');
  displays[0].workArea = { x: 0, y: 0, width: 400, height: 500 };
  const clamped = clampBounds(app.surface().bounds(), displays.map(item => item.workArea));
  app.clamp(); assert.deepEqual(app.raw(), expected); await app.flush();
  assert.deepEqual(app.raw(), app.screen.dipToScreenRect(null, clamped), 'changed work area still clamps on the deferred turn');
});

test('occlusion evidence reports GetWindowRect directly without reconverting rounded logical bounds', async () => {
  const app = await harness({ ...defaults(), bounds: { x: 71, y: 83, width: 375, height: 491 } }, [display()]);
  const expected = { ...app.raw(), x: app.raw().x + 1, width: app.raw().width - 1 };
  app.external(expected);
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(4n);
  const receipt = app.surface().occlusionReceipt({ getNativeWindowHandle: () => handle, isVisible: () => true, getBounds: () => expected });
  assert.deepEqual(copy(receipt.widgetNativeBounds), expected);
});

test('automatic movement before Show or immediate quit never becomes the saved user placement', async context => {
  for (const action of ['show', 'quit'] as const) await context.test(action, async () => {
    const displays = [display()];
    let app = await harness({ ...defaults(), bounds: { x: 121, y: 143, width: 375, height: 490 } }, displays);
    const expected = app.raw(), intended = copy(app.preferences());
    app.external({ x: expected.x - 4, y: expected.y - 15, width: expected.width + 4, height: expected.height + 3 }, false);
    if (action === 'show') { app.show(); await app.flush(); assert.deepEqual(app.raw(), expected); }
    else await app.quit();
    assert.deepEqual(copy(app.preferences()), intended, 'system geometry must never replace the user placement');
    app = await harness(await new PreferenceStore(app.root).load(), displays, app.root);
    assert.deepEqual(app.raw(), expected);
  });
});

test('sleep and lock preserve intended pixels despite automatic move and resize notifications', async context => {
  for (const [pause, resume] of [['suspend', 'resume'], ['lock-screen', 'unlock-screen']]) await context.test(pause, async () => {
    const app = await harness({ ...defaults(), bounds: { x: 121, y: 143, width: 375, height: 490 } }, [display()]);
    const expected = app.raw(), intended = copy(app.preferences()), positions = app.positions();
    app.power(pause);
    app.external({ x: expected.x - 4, y: expected.y - 15, width: expected.width + 4, height: expected.height + 3 }, false);
    app.displayEvent('display-metrics-changed'); await app.flush();
    assert.deepEqual(copy(app.preferences()), intended, 'paused native notifications must not overwrite intent');
    assert.equal(app.positions(), positions, 'paused geometry work must not call SetWindowPos');
    app.power(resume); await app.flush();
    assert.deepEqual(app.raw(), expected);
    assert.deepEqual(await new PreferenceStore(app.root).load(), intended);
  });
});

test('temporary display loss preserves original intent through resume, a cold start and display return', async () => {
  const original = display(), temporary = { ...display(1), bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 760, height: 560 } };
  const displays = [copy(original)];
  let app = await harness({ ...defaults(), bounds: { x: 1217, y: 413, width: 375, height: 490 } }, displays);
  const expected = app.raw(), intended = copy(app.preferences());
  app.power('suspend'); displays.splice(0, 1, copy(temporary));
  app.external({ x: 190, y: 80, width: 565, height: 737 }, false); app.displayEvent('display-removed'); await app.flush();
  app.power('resume'); await app.flush();
  const fallback = app.screen.dipToScreenRect(null, clampBounds(intended.bounds, displays.map(item => item.workArea)));
  assert.deepEqual(app.raw(), fallback, 'the temporary layout remains usable through the existing clamp');
  assert.deepEqual(copy(app.preferences()), intended);
  await app.quit();
  app = await harness(await new PreferenceStore(app.root).load(), displays, app.root);
  assert.deepEqual(app.raw(), fallback, 'a durable changed layout remains deterministic across cold starts');
  displays.splice(0, 1, copy(original)); app.displayEvent('display-added'); await app.flush();
  assert.deepEqual(app.raw(), expected, 'returning to the original display restores the exact original pixels');
  assert.deepEqual(copy(app.preferences()), intended);
});

test('a deliberate move on the temporary layout supersedes the old layout intent', async () => {
  const original = display(), temporary = { ...display(1), bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 760, height: 560 } };
  const displays = [copy(original)];
  const app = await harness({ ...defaults(), bounds: { x: 1217, y: 413, width: 375, height: 490 } }, displays);
  const old = app.raw();
  displays.splice(0, 1, copy(temporary)); app.displayEvent('display-metrics-changed'); await app.flush();
  const userChoice = { ...app.raw(), x: app.raw().x - 11, y: app.raw().y - 9 };
  app.external(userChoice); await app.flush();
  const intended = copy(app.preferences());
  assert.deepEqual(intended.nativePlacement?.native, userChoice);
  displays.splice(0, 1, copy(original)); app.displayEvent('display-added'); await app.flush();
  assert.deepEqual(app.raw(), app.screen.dipToScreenRect(null, clampBounds(intended.bounds, displays.map(item => item.workArea))));
  assert.notDeepEqual(app.raw(), old, 'old display intent cannot override a later user gesture');
  assert.deepEqual(copy(app.preferences()), intended);
});

test('display notifications never fight a manual drag, including a scale change during the gesture', async () => {
  const displays = [display()];
  const app = await harness({ ...defaults(), bounds: { x: 121, y: 143, width: 375, height: 490 } }, displays);
  let userChoice = { ...app.raw(), x: app.raw().x + 31, y: app.raw().y + 17 };
  app.external(userChoice, true, false); app.displayEvent('display-metrics-changed'); await app.flush();
  assert.deepEqual(app.raw(), userChoice);
  displays[0] = display(1.75);
  userChoice = { ...userChoice, x: userChoice.x + 21, y: userChoice.y + 17 };
  app.external(userChoice, true, false); app.displayEvent('display-metrics-changed'); await app.flush();
  assert.deepEqual(app.raw(), userChoice);
  app.finishGesture(); await app.flush();
  assert.deepEqual(copy(app.preferences().nativePlacement?.native), userChoice);
  assert.deepEqual((await new PreferenceStore(app.root).load()).nativePlacement?.native, userChoice);
});

test('a stale pending manual gesture cannot adopt system geometry after pause or window destruction', async context => {
  for (const pause of ['suspend', 'lock-screen', 'destroy']) await context.test(pause, async () => {
    const app = await harness({ ...defaults(), bounds: { x: 121, y: 143, width: 375, height: 490 } }, [display()]);
    const expected = app.raw(), intended = copy(app.preferences());
    app.external({ ...expected, x: expected.x + 21 }, true, false);
    if (pause === 'destroy') app.destroy(); else app.power(pause);
    app.external({ x: expected.x - 4, y: expected.y - 15, width: expected.width + 4, height: expected.height + 3 }, false);
    await app.flush();
    if (pause !== 'destroy') { app.power(pause === 'suspend' ? 'resume' : 'unlock-screen'); await app.flush(); }
    assert.deepEqual(app.raw(), expected);
    assert.deepEqual(copy(app.preferences()), intended);
  });
});

test('automatic restoration reaches quiescence without adopting pixels or repeatedly writing preferences', async () => {
  const app = await harness({ ...defaults(), bounds: { x: 121, y: 143, width: 375, height: 490 } }, [display()]);
  const expected = app.raw(), positions = app.positions(), writes = app.writes();
  app.external({ ...expected, x: expected.x - 4, width: expected.width + 4 }, false); await app.flush();
  assert.deepEqual(app.raw(), expected); assert.equal(app.pending(), 0);
  assert.equal(app.positions(), positions + 1, 'only one corrective native placement is needed');
  assert.equal(app.writes(), writes, 'automatic restoration does not create preference writes');
  await app.flush(); assert.equal(app.positions(), positions + 1); assert.equal(app.writes(), writes);
});
