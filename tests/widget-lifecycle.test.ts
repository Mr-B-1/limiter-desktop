import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { ActivityGate } from '../src/services/activity.js';
import { Coordinator, type Clock } from '../src/services/scheduler.js';
import { defaults, parsePreferences } from '../src/services/store.js';
import { appendLaunch } from '../src/services/launches.js';
import { validHost, validLabel } from '../src/shared/storage.js';
import { ageLabel, countdown, type DisplayState } from '../src/shared/usage.js';

// Execute the production functions and registered handlers with controlled boundaries, without starting Electron.
const sources = new Map(['src/main.ts', 'src/renderer/widget.ts'].map(file => [file, ts.createSourceFile(file, readFileSync(path.join(process.cwd(), file), 'utf8'), ts.ScriptTarget.Latest, true)]));
function declaration(file: string, name: string): string {
  const source = sources.get(file)!;
  const found = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, name);
  return found.getText(source);
}
function handler(file: string, expression: string, event: string): string {
  const source = sources.get(file)!;
  let found: string | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === expression && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === event) found = node.arguments[1].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, expression + ':' + event);
  return found;
}
function evaluate<T>(source: string, globals: Record<string, unknown>): T {
  const context = vm.createContext({ ...globals, Error });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.testApi as T;
}
function constant(file: string, name: string): string {
  const source = sources.get(file)!;
  const found = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === name));
  assert.ok(found, name);
  return found.getText(source);
}
const main = (name: string) => declaration('src/main.ts', name);
const renderer = (name: string) => declaration('src/renderer/widget.ts', name);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

function settingsUi(updateSettings: (value: unknown) => Promise<void> = async () => {}) {
  const elements = new Map<string, { value: string; defaultValue: string; textContent: string; hidden: boolean; checked: boolean; setAttribute: () => void }>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', defaultValue: '', textContent: '', hidden: false, checked: false, setAttribute: () => {} });
    return elements.get(id)!;
  };
  const document = { activeElement: null as unknown };
  const api = evaluate<{
    renderSettings: (state: Pick<DisplayState, 'config'>) => void;
    settingsAction: (run: () => Promise<void>, done: string) => void;
    openPanel: (panel: string | null) => void;
    clearRemote: () => void;
  }>(`${renderer('renderSettings')}\n${renderer('settingsAction')}\n${renderer('openPanel')}\nconst clearRemote=${handler('src/renderer/widget.ts', "element('clear-remote').addEventListener", 'click')};\nglobalThis.testApi={renderSettings,settingsAction,openPanel,clearRemote};`,
  { document, element, panel: null, renderDetails: () => {}, window: { limiter: { updateSettings } } });
  return { ...api, element, document };
}
const configuration = (): Pick<DisplayState, 'config'> => ({ config: { projectsRoot: null, grokcliRoot: null, localDiskLabel: 'Original', pcName: 'Test PC', remoteDisk: { host: 'test-server', label: 'Old server' }, startWithWindows: false, startupShortcut: false, firstRun: false } });

test('Settings drafts survive focus changes, recurring pushes and reopening, then an explicit clear removes remote drafts', async () => {
  const state = configuration();
  const ui = settingsUi(async () => { state.config.remoteDisk = null; ui.renderSettings(state); });
  ui.renderSettings(state);
  ui.openPanel('settings');
  ui.element('local-disk-label').value = 'New desktop';
  ui.document.activeElement = ui.element('remote-disk-label');
  ui.element('remote-disk-label').value = 'New server';
  ui.renderSettings(state);
  ui.document.activeElement = ui.element('save-disks');
  ui.renderSettings(state);
  ui.openPanel(null); ui.openPanel('settings'); ui.renderSettings(state);
  assert.equal(ui.element('local-disk-label').value, 'New desktop');
  assert.equal(ui.element('remote-disk-label').value, 'New server');
  ui.clearRemote(); await tick();
  assert.equal(ui.element('remote-disk-label').value, '');
  assert.equal(ui.element('remote-disk-host').value, '');
  assert.equal(ui.element('local-disk-label').value, 'New desktop');
});

test('Settings reports write failure, still refreshes session providers, and reports success after retry', async () => {
  let fail = true, refreshes = 0;
  const api = evaluate<{ updateSettings: (value: unknown) => Promise<void>; persist: () => Promise<unknown>; notice: () => string | null }>(`${main('persist')}\n${main('updateSettings')}\nglobalThis.testApi={updateSettings,persist,notice:()=>settingsNotice};`, {
    preferences: defaults(), settingsNotice: null, startWithWindowsState: false, path, parsePreferences, validHost, validLabel, isFolder: async () => true,
    store: { save: async () => { if (fail) throw Object.assign(new Error('Synthetic disk full'), { code: 'ENOSPC' }); } },
    send: () => {}, storage: { refresh: async () => { refreshes++; } }, grok: { refresh: async () => {} }, loginItem: { set: () => {}, enabled: () => false }
  });
  const ui = settingsUi();
  ui.settingsAction(() => api.updateSettings({ localDiskLabel: 'New desktop' }), 'Disk names saved.');
  await tick();
  assert.notEqual(ui.element('settings-status').textContent, 'Disk names saved.');
  assert.match(ui.element('settings-status').textContent, /not.*saved|could not be saved/i);
  assert.equal(refreshes, 1, 'session settings must still reach providers after a persistence failure');
  await assert.doesNotReject(api.persist(), 'background save failures remain handled');
  fail = false;
  ui.settingsAction(() => api.updateSettings({ localDiskLabel: 'New desktop' }), 'Disk names saved.');
  await tick();
  assert.equal(ui.element('settings-status').textContent, 'Disk names saved.');
  assert.equal(api.notice(), null, 'a successful retry clears the earlier persistence warning');
});

function sourcePicker() {
  const oldStop = deferred();
  let dialogs = 0, failDialog = false;
  const owned = [{ id: 'old', stopped: false, started: true, on: () => {}, read: async () => ({}), stop: () => oldStop.promise.then(() => { owned[0].stopped = true; }) }];
  class Poller {
    constructor(readonly read: () => Promise<unknown>) {}
    trigger() { return this.read(); }
    async stop() {}
    invalidate() {}
    reportFailure() {}
    suspend() {}
  }
  const api = evaluate<{ choose: () => Promise<void>; quit: () => void }>(`${main('startProvider')}\nconst choose=${handler('src/main.ts', 'handle', 'limiter:choose-source')};\nglobalThis.testApi={choose,quit:()=>{quitting=true;}};`, {
    provider: owned[0], coordinator: { stop: async () => {} }, sourceSelection: null, preferences: defaults(), quitting: false, gate: undefined,
    window: {}, path, stateRoot: 'C:/fixture', dialog: { showOpenDialog: async () => { dialogs++; if (failDialog) throw new Error('Synthetic picker failure'); return { canceled: false, filePaths: ['C:/fixture/codex.exe'] }; } },
    persist: async () => true, send: () => {}, Coordinator: Poller,
    CodexProvider: { local: () => { const source = { id: 'new-' + owned.length, stopped: false, started: false, on: () => {}, stop: async () => { source.stopped = true; }, read: async () => { source.started = true; return {}; } }; owned.push(source); return source; } }
  });
  return { ...api, oldStop, owned, dialogs: () => dialogs, failPicker: (value: boolean) => { failDialog = value; } };
}
test('overlapping source choices keep one provider, and a failed choice permits retry', async () => {
  const picker = sourcePicker();
  picker.failPicker(true);
  await assert.rejects(picker.choose(), /picker failure/);
  picker.failPicker(false);
  const first = picker.choose(), second = picker.choose();
  await tick(); picker.oldStop.resolve(); await Promise.all([first, second]);
  assert.equal(picker.dialogs(), 2, 'one failed dialog plus one shared successful dialog');
  assert.equal(picker.owned.filter(source => source.started && !source.stopped).length, 1);
});
test('quit during a source change never starts a late replacement', async () => {
  const picker = sourcePicker();
  const pending = picker.choose(); await tick(); picker.quit(); picker.oldStop.resolve(); await pending;
  assert.equal(picker.owned.filter(source => source.id !== 'old').length, 0);
});

test('the registered resume handler honors lock and idle, then permits one active refresh', async () => {
  let now = 0, reads = 0, sequence = 0, idle = 0;
  const timers = new Map<number, { run: () => void; due: number }>();
  const clock: Clock = { now: () => now, wall: () => 2e12 + now, set: (run, delay) => { timers.set(++sequence, { run, due: now + delay }); return sequence; }, clear: id => { timers.delete(id as number); } };
  const coordinator = new Coordinator(async () => { reads++; return { windows: [] } as unknown as NonNullable<DisplayState['snapshot']>; }, () => {}, clock, () => 0);
  const gate = new ActivityGate(() => idle, () => coordinator.suspend(), () => coordinator.resume());
  const resume = evaluate<() => void>(`globalThis.testApi=${handler('src/main.ts', 'powerMonitor.on', 'resume')};`, { coordinator, gate });
  try {
    await coordinator.trigger('start'); gate.lock(); coordinator.suspend(); now += 3600000; resume(); await tick();
    now += 300000; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.run(); }
    await tick();
    assert.equal(gate.paused, true); assert.equal(reads, 1);
    gate.unlock(); await tick(); assert.equal(reads, 2);
    coordinator.suspend(); idle = 300; now += 300000; resume(); await tick(); assert.equal(reads, 2);
    idle = 0; resume(); await tick(); assert.equal(reads, 3);
    now += 10000; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.run(); }
    await tick(); assert.equal(reads, 3, 'active transition must not queue a second resume read');
  } finally { await coordinator.stop(); }
});

test('launch writes serialize complete history updates and recover after a write failure', async () => {
  let history = JSON.stringify([{ at: 'initial', uptimeMinutes: 1, kind: 'start' }]), reads = 0, writes = 0;
  const release = deferred();
  const api = evaluate<{ recordLaunch: (kind: string, detail: string) => Promise<void>; launchHistory: () => Promise<unknown> }>(`${main('recordLaunch')}\n${main('launchHistory')}\nglobalThis.testApi={recordLaunch,launchHistory};`, {
    launchWrites: Promise.resolve(), settingsNotice: null,
    fs: { readFile: async () => { reads++; return history; }, mkdir: async () => {}, writeFile: async (_name: string, data: string) => { await release.promise; if (++writes === 3) throw new Error('Synthetic history write failure'); history = data; } },
    launchesFile: 'fixture/launches.json', stateRoot: 'fixture', appendLaunch, localStamp: () => 'now PST', timeZone: 'America/Vancouver', os: { uptime: () => 60 }
  });
  const pending = Promise.all([api.recordLaunch('second', 'A'), api.recordLaunch('second', 'B')]);
  await tick(); const readsBeforeRelease = reads;
  release.resolve(); await pending;
  assert.equal(readsBeforeRelease, 1, 'the second launch must not read before the first write finishes');
  assert.equal(JSON.parse(history).length, 3);
  await api.recordLaunch('second', 'failed'); await api.recordLaunch('second', 'recovered');
  const saved = await api.launchHistory() as { detail?: string }[];
  assert.equal(saved.length, 4); assert.equal(saved.at(-1)?.detail, 'recovered');
});

test('the production Grok factory forwards its cancellation signal to the quota transport', async () => {
  const source = sources.get('src/main.ts')!;
  let factory: string | undefined;
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'GrokProvider') factory = node.arguments?.[1].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(factory);
  const controller = new AbortController(); let forwarded: AbortSignal | undefined;
  const read = evaluate<(signal: AbortSignal) => Promise<unknown>>(`globalThis.testApi=${factory};`, {
    preferences: { grokcliRoot: 'C:/fixture' }, readGrokQuota: async (_root: string, _python: unknown, signal: AbortSignal) => { forwarded = signal; return { ok: false, status: 'setup' }; }
  });
  await read(controller.signal); assert.equal(forwarded, controller.signal);
});

test('Antigravity rows: hidden without an install, one card per pool, stale reading greyed, and a passed reset asks to open the app', () => {
  // A small stand-in for the DOM: nodes register their ids once they are inserted before the disk row.
  const byId = new Map<string, FakeNode>();
  class FakeNode {
    id = ''; className = ''; hidden = false; textContent = ''; dataset: Record<string, string> = {}; style: Record<string, string> = {};
    attributes = new Map<string, string>(); children: (FakeNode | string)[] = [];
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    removeAttribute(key: string) { this.attributes.delete(key); }
    append(...nodes: (FakeNode | string)[]) { this.children.push(...nodes); }
    addEventListener() {}
    before(node: FakeNode) { const add = (item: FakeNode | string) => { if (typeof item === 'string') return; if (item.id) byId.set(item.id, item); item.children.forEach(add); }; add(node); }
  }
  byId.set('local-card', new FakeNode());
  const document = { createElement: () => new FakeNode(), getElementById: (id: string) => byId.get(id) ?? null };
  const element = (id: string) => { const found = byId.get(id); assert.ok(found, id); return found; };
  const file = 'src/renderer/widget.ts';
  const render = evaluate<(state: unknown) => void>(`${constant(file, 'antigravityLabels')}
${constant(file, 'percent')}
${renderer('meter')}
${renderer('antigravityCard')}
${renderer('renderAntigravity')}
globalThis.testApi=renderAntigravity;`,
    { document, element, countdown, ageLabel, openPanel: () => {}, Date, Math, String });
  const soon = Math.floor(Date.now() / 1000) + 2 * 3600 + 30;
  const pools = [{ name: 'Gemini', models: ['a', 'b', 'c', 'd', 'e', 'f'], remainingPercent: 86.2, resetsAt: soon }, { name: 'Claude, GPT', models: ['g', 'h', 'i'], remainingPercent: 100, resetsAt: soon }];
  const state = (status: string, snapshot: unknown, stale = false) => ({ status, snapshot, stale, refreshing: false });
  render(state('absent', null)); render(state('loading', null));
  assert.equal(byId.has('ag-0-card'), false);
  render(state('ready', { observedAt: Date.now(), plan: 'Pro', pools }));
  assert.deepEqual(['ag-0', 'ag-1'].map(id => [element(id + '-pool').textContent, element(id + '-percent').textContent, element(id + '-meta').textContent, element(id + '-card').hidden]),
    [['Gemini', '86.2% left', 'Pro plan · 6 models', false], ['Claude, GPT', '100% left', 'Pro plan · 3 models', false]]);
  assert.match(element('ag-0-reset').textContent, /^2h \d+m$/);
  assert.equal(element('ag-0-meter').attributes.get('aria-valuenow'), '86.2');
  render(state('closed', { observedAt: Date.now() - 12 * 60000, plan: 'Pro', pools }, true));
  assert.equal(element('ag-0-card').dataset.stale, 'true');
  assert.equal(element('ag-0-meta').textContent, 'Stale · Read 12m ago');
  render(state('closed', { observedAt: Date.now() - 6 * 3600000, plan: 'Pro', pools: [{ ...pools[0], resetsAt: soon - 3 * 3600 }] }, true));
  assert.deepEqual([element('ag-0-percent').textContent, element('ag-0-meta').textContent, element('ag-0-card').dataset.stale, element('ag-1-card').hidden], ['··', 'Open Antigravity to refresh', 'false', true]);
  render(state('signed-out', null));
  assert.deepEqual([element('ag-0-meta').textContent, element('ag-0-percent').textContent], ['Sign in to Antigravity', '··']);
  render(state('ready', { observedAt: Date.now(), plan: 'Pro', pools: [{ name: 'Gemini', models: ['a'], remainingPercent: null, resetsAt: soon }] }));
  assert.deepEqual([element('ag-0-percent').textContent, element('ag-0-meta').textContent, element('ag-0-meter').attributes.get('aria-valuenow')], ['··', 'Percentage not reported', undefined]);
  assert.match(element('ag-0-reset').textContent, /^2h \d+m$/);
  render(state('ready', { observedAt: Date.now(), plan: 'Pro', pools: [{ name: 'Gemini', models: ['a'], remainingPercent: 0, resetsAt: soon }] }));
  assert.deepEqual([element('ag-0-percent').textContent, element('ag-0-meter').attributes.get('aria-valuenow')], ['0% left', '0']);
  render(state('absent', null));
  assert.equal(element('ag-0-card').hidden, true);
});
