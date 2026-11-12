import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, protocol, screen, session, shell, Tray } from 'electron';
import { promises as fs, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActivityGate } from './services/activity.js';
import { AlertTracker, type AlertRow } from './services/alerts.js';
import { Forecast } from './services/forecast.js';
import { insidePackage, relayArgs, startedByAgent, startupShortcut } from './services/launch-guard.js';
import { appendLaunch, localStamp, type LaunchRecord } from './services/launches.js';
import { LoginItem, memoryLoginItemOs } from './services/login-item.js';
import { spawn } from 'node:child_process';
import { CodexProvider } from './providers/codex.js';
import { Coordinator } from './services/scheduler.js';
import { PreferenceStore, clampBounds, COMPACT_SIZE, parsePreferences, type Preferences } from './services/store.js';
import { DesktopSurface } from './services/desktop.js';
import { nativeMachine } from './services/emulation.js';
import { DOWNLOAD_PAGE, wrongBuildForPc } from './shared/platform.js';
import { resizeBounds, resizeEdges, type ResizeEdge } from './services/resize.js';
import type { Bounds } from './services/store.js';
import { ClaudeProvider, claudePipe } from './providers/claude.js';
import zlib from 'node:zlib';
import { ClaudeEstimator, SCAN_INTERVAL_MS, parseReadingInput } from './providers/claude-local.js';
import { ClaudeModReader, defaultModFile, newestExact } from './providers/claude-mod.js';
import { CodexRolloutReader, codexSessionsRoot } from './providers/codex-rollouts.js';
import { claudeWindow, codexWindow, rank } from './services/projects.js';
import { GrokProvider, readGrokQuota } from './providers/grok.js';
import { StorageProvider, type StorageConfig } from './providers/storage.js';
import { emptyStorage, formatDiskBytes, validHost, validLabel } from './shared/storage.js';
import { defaultRoots } from './shared/projects.js';
import type { DisplayState, Theme } from './shared/usage.js';

const local = process.env.LOCALAPPDATA;
if (!local) throw new Error('Host-local application data is unavailable.');
const testing = process.argv.includes('--smoke-test') || process.argv.includes('--smoke-child');
// State lives outside AppData so a launch from inside an app package shares the same files and single-instance lock.
const legacyStateRoot = path.join(local, 'Limiter');
// A smoke run may name its own profile so each architecture and run starts from nothing.
const smokeProfile = process.argv.find(arg => arg.startsWith('--smoke-profile='))?.slice('--smoke-profile='.length);
const stateRoot = testing ? (smokeProfile && path.isAbsolute(smokeProfile) ? smokeProfile : path.join(local, 'Limiter-build/smoke/profile')) : path.join(os.homedir(), '.local', 'share', 'Limiter', 'state');
const APP_ID = 'Limiter.Desktop';
// An x64 build on an ARM64 PC only shows a message, so it keeps its browser data in a temporary folder, away from a running Limiter's.
const wrongBuild = wrongBuildForPc(process.arch, nativeMachine());
const chromiumRoot = wrongBuild ? path.join(os.tmpdir(), 'Limiter-wrong-build') : path.join(stateRoot, 'chromium');
app.setPath('userData', chromiumRoot);
app.setPath('sessionData', chromiumRoot);
app.setAppUserModelId(APP_ID);
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'limiter', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let provider: CodexProvider;
let coordinator: Coordinator;
let claude: ClaudeProvider;
let modReader: ClaudeModReader;
const forecast = new Forecast();
const alerts = new AlertTracker();
let gate: ActivityGate;
let slowTick: NodeJS.Timeout;
let toastsShown = 0;
let receiptToasts = 0;
let migratedLegacyState = false;
let startMenuShortcut: { path: string; appUserModelId: string | undefined } | null = null;
let estimator: ClaudeEstimator;
let codexReader: CodexRolloutReader;
let codexScan: Promise<void> | null = null;
let codexScanned = false;
let codexTimer: NodeJS.Timeout | undefined;
// Reads the Codex rollouts on the Claude scanner's cadence; a missing or unreadable root leaves the Codex list empty, never the widget broken.
function scanCodexRollouts(): Promise<void> {
  if (codexScan) return codexScan;
  codexScan = codexReader.scan(Date.now()).then(() => { codexScanned = true; }).catch(() => { codexScanned = false; }).finally(() => { codexScan = null; send(); });
  return codexScan;
}
function projectViews(now: number): DisplayState['projects'] {
  const claude = estimator && modReader ? estimator.view(exactClaude().state) : null;
  const claudeSpan = claudeWindow(now, claude?.weekly.resetsAt ?? null);
  const roots = defaultRoots(os.homedir(), preferences?.projectsRoot ?? null);
  const codexSpan = codexWindow(now, coordinator?.snapshot || null);
  return {
    claude: rank(estimator ? estimator.projects(claudeSpan.start, now, roots) : [], claudeSpan, null),
    codex: rank(codexReader && codexScanned ? codexReader.byProject(codexSpan.start, now, roots) : [], codexSpan, codexReader && codexScanned ? codexReader.coverage() : null) };
}
// Synced copies written by the same mod on other hosts; each host's file carries its own name.
function exactClaude() {
  return newestExact(claude?.state() || { status: 'waiting', sample: null, ageMs: null }, modReader?.state() || { status: 'waiting', sample: null, ageMs: null, host: null });
}
let grok: GrokProvider;
let storage: StorageProvider;
let desktop: DesktopSurface | null = null;
let resizeOrigin: { bounds: Bounds; edge: ResizeEdge; area: Bounds } | null = null;
let hiddenByUser = false;
let recreateTimer: NodeJS.Timeout | undefined;
let preferences: Preferences;
let store: PreferenceStore;
let tick: NodeJS.Timeout | undefined;
let saveTimer: NodeJS.Timeout | undefined;
let quitting = false;
let shutdown: Promise<void> | null = null;
let duplicateLaunches = 0;
let settingsNotice: string | null = null;
let trayMenu: Menu;
let shutdownReceipt: ((childAbsent: boolean) => Promise<void>) | null = null;
const startedAt = performance.now();

function display(): DisplayState {
  return { status: coordinator?.status || 'loading', snapshot: coordinator?.snapshot || null,
    ageMs: coordinator?.ageMs ?? null, stale: coordinator?.stale || false, refreshing: coordinator?.refreshing || false,
    cooldownMs: coordinator?.cooldownMs || 0, pinned: false,
    theme: preferences?.theme || 'system', settingsNotice, desktopAttached: desktop?.attached || false,
    claude: estimator?.view(exactClaude().state, exactClaude().source ? { source: exactClaude().source!, host: exactClaude().host } : null) || { mode: 'scanning', weekly: { percent: null, resetsAt: null },
      fiveHour: { percent: null, resetsAt: null }, ageMs: null, anchor: null, coverage: { files: 0, replies: 0, unknownModels: 0 }, refreshing: false, exact: null },
    grok: grok?.state() || { status: 'loading', snapshot: null, stale: false, refreshing: false },
    storage: storage?.state() || emptyStorage(),
    forecast: forecastViews(), projects: projectViews(Date.now()), config: configView() };
}
// The per-user setup shown in Settings; a fresh profile opens Settings once.
let firstRun = false;
// The smoke run keeps the sign-in entry in memory, so building and testing never adds a Run value on the build machine.
const smokeLoginOs = memoryLoginItemOs();
const loginItem = new LoginItem(testing ? smokeLoginOs : { get: options => app.getLoginItemSettings(options), set: options => app.setLoginItemSettings(options) }, process.execPath);
// Read once at boot and after each change, not on every one-second state push.
let startWithWindowsState = false;
let startupShortcutState = false;
function startWithWindows(): boolean { return startWithWindowsState; }
function configView(): DisplayState['config'] {
  return { projectsRoot: preferences?.projectsRoot ?? null, grokcliRoot: preferences?.grokcliRoot ?? null, localDiskLabel: preferences?.localDiskLabel ?? null,
    pcName: os.hostname(), remoteDisk: preferences?.remoteDisk ?? null, startWithWindows: startWithWindows(),
    startupShortcut: startupShortcutState, firstRun };
}
function storageConfig(): StorageConfig {
  return { localLabel: preferences?.localDiskLabel || os.hostname(), localVolume: process.env.SystemDrive || 'C:', remote: preferences?.remoteDisk ?? null };
}
async function isFolder(item: string): Promise<boolean> {
  try { return (await fs.stat(item)).isDirectory(); } catch { return false; }
}
// Applies one Settings change from the renderer; every value is validated here, never trusted from the page.
async function updateSettings(value: unknown): Promise<void> {
  if (!value || typeof value !== 'object') throw new Error('Invalid settings change');
  const change = value as Record<string, unknown>;
  // Folder checks wait on the disk; every other field is applied after them to the latest preferences, so nothing changed meanwhile is lost.
  const folders: Partial<Pick<Preferences, 'projectsRoot' | 'grokcliRoot'>> = {};
  for (const key of ['projectsRoot', 'grokcliRoot'] as const) {
    if (!(key in change)) continue;
    const folder = change[key];
    if (folder !== null && (typeof folder !== 'string' || !path.isAbsolute(folder) || !await isFolder(folder))) throw new Error('Choose an existing folder');
    folders[key] = folder as string | null;
  }
  const next = { ...preferences, ...folders };
  if ('localDiskLabel' in change) {
    const label = change.localDiskLabel;
    if (label !== null && label !== '' && !validLabel(label)) throw new Error('Disk names are 1 to 24 characters');
    next.localDiskLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
  }
  if ('remoteDisk' in change) {
    const remote = change.remoteDisk;
    if (remote === null) next.remoteDisk = null;
    else if (remote && typeof remote === 'object' && validHost((remote as Record<string, unknown>).host) && validLabel((remote as Record<string, unknown>).label))
      next.remoteDisk = { host: (remote as { host: string }).host, label: (remote as { label: string }).label.trim() };
    else throw new Error('Use an SSH host name from your SSH config and a name of 1 to 24 characters');
  }
  if ('startWithWindows' in change) {
    if (typeof change.startWithWindows !== 'boolean') throw new Error('Invalid start-up choice');
    loginItem.set(change.startWithWindows);
    startWithWindowsState = loginItem.enabled();
  }
  const grokChanged = next.grokcliRoot !== preferences.grokcliRoot;
  // The store's own validation (path length, characters, labels) runs here, before anything is kept.
  preferences = parsePreferences(next);
  await persist();
  await storage.refresh();
  if (grokChanged) await grok.refresh();
  send();
}
async function chooseFolder(kind: unknown): Promise<void> {
  if (!window || (kind !== 'projects' && kind !== 'grokcli')) return;
  const choice = await dialog.showOpenDialog(window, { title: kind === 'projects' ? 'Choose your projects folder' : 'Choose your grokcli folder', properties: ['openDirectory'] });
  if (choice.canceled || !choice.filePaths[0]) return;
  await updateSettings(kind === 'projects' ? { projectsRoot: choice.filePaths[0] } : { grokcliRoot: choice.filePaths[0] });
}
function forecastViews(): DisplayState['forecast'] {
  const selected = coordinator?.snapshot?.windows.find(window => window.key === coordinator?.snapshot?.selectedKey);
  const claude = estimator && modReader ? estimator.view(exactClaude().state) : null;
  return {
    codex: forecast.project('codex', selected?.resetsAt ?? null),
    'claude-week': forecast.project('claude-week', claude?.weekly.resetsAt ?? null),
    'claude-5h': forecast.project('claude-5h', claude?.fiveHour.resetsAt ?? null),
    grok: forecast.project('grok', grok?.state().snapshot?.resetsAt ?? null) };
}
function send(): void {
  if (window && !window.isDestroyed() && window.webContents.getURL().startsWith('limiter://widget/')) window.webContents.send('limiter:changed', display());
}
async function persist(): Promise<void> {
  try { await store.save(preferences); }
  catch { settingsNotice = 'Preferences could not be saved. This session still works.'; send(); }
}
function show(): void {
  if (!window || window.isDestroyed()) return;
  hiddenByUser = false;
  const bounds = clampBounds(preferences.bounds, screen.getAllDisplays().map(display => display.workArea));
  if (desktop?.attach(bounds)) desktop.show();
  coordinator.visibility(false);
}
const launchesFile = path.join(stateRoot, 'launches.json');
// Records each launch with the PC's uptime; a failed write is shown in Settings rather than dropped.
async function recordLaunch(kind: LaunchRecord['kind'], detail?: string): Promise<void> {
  try {
    let existing: unknown = [];
    // A missing or unreadable history starts fresh; appendLaunch drops malformed entries.
    try { existing = JSON.parse(await fs.readFile(launchesFile, 'utf8')); } catch { existing = []; }
    const history = appendLaunch(existing, { at: localStamp(new Date()), uptimeMinutes: Math.round(os.uptime() / 6) / 10, kind, ...(detail ? { detail } : {}) });
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(launchesFile, JSON.stringify(history, null, 2) + '\n');
  } catch (error) {
    settingsNotice = 'Launch history could not be saved: ' + (error instanceof Error ? error.message : 'unknown error');
  }
}
async function launchHistory(): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(launchesFile, 'utf8')); } catch { return null; }
}
async function diagnostic(): Promise<void> {
  const verifiedAt = localStamp(new Date());
  await fs.writeFile(path.join(stateRoot, 'last-diagnostic.json'), JSON.stringify({ version: app.getVersion(), executable: process.execPath, pid: process.pid,
    verifiedAt, desktop: desktop?.inspect() || null, duplicateLaunches, hiddenByUser,
    providers: { codex: coordinator?.status, claude: claude?.state().status, grok: grok?.state().status }, storage: storage?.state(), toastsShown: receiptToasts, gatePaused: gate?.paused ?? null,
    launchGuard: { insidePackage: insidePackage(), startedByAgent: startedByAgent() }, stateRoot, migratedLegacyState,
    claudeSampleReceived: !!claude?.state().sample, claudeMode: display().claude.mode, claudeCoverage: display().claude.coverage,
    projects: display().projects, codexRolloutReads: codexReader?.counts ?? null, launches: await launchHistory(),
    modelTurnsStarted: 0, sourcePid: provider?.pid }, null, 2));
}
// Lets a reading be entered from a shortcut or terminal, e.g. Limiter.exe --claude-weekly=80 --claude-weekly-resets=12h32m.
async function calibrateFromArgs(args: string[]): Promise<void> {
  const value = (name: string) => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1) ?? '';
  try {
    await estimator.calibrate(parseReadingInput({ weeklyPercent: value('--claude-weekly'), weeklyResetsIn: value('--claude-weekly-resets'),
      fiveHourPercent: value('--claude-5h'), fiveHourResetsIn: value('--claude-5h-resets') }, Date.now()));
  } catch { settingsNotice = 'Claude reading not saved. Check the numbers and try again.'; send(); }
}
function hide(): void { resizeOrigin = null; hiddenByUser = true; window?.hide(); coordinator.visibility(true); }
async function refresh(): Promise<void> { await Promise.all([coordinator.trigger('manual'), storage.refresh(), estimator.refresh(), modReader.refresh(), grok.refresh(), scanCodexRollouts()]); send(); }
function theme(value: Theme): void {
  preferences.theme = value;
  nativeTheme.themeSource = value;
  void persist();
  send();
}
function rebuildMenu(): void {
  trayMenu = Menu.buildFromTemplate([
    { id: 'show', label: 'Show on desktop', click: show },
    { id: 'hide', label: 'Hide to tray', click: hide },
    { id: 'refresh', label: 'Refresh usage', click: () => { void refresh(); } },
    { type: 'separator' },
    { label: 'Desktop widget, apps stay above', enabled: false },
    { type: 'separator' },
    { id: 'quit', label: 'Quit Limiter', click: () => { void quit(); } }
  ]);
  tray?.setContextMenu(trayMenu);
}
async function quit(): Promise<void> {
  if (shutdown) return shutdown;
  quitting = true;
  resizeOrigin = null;
  shutdown = (async () => {
    clearInterval(tick); clearInterval(slowTick); clearInterval(codexTimer); clearTimeout(saveTimer); clearTimeout(recreateTimer);
    const childPid = provider?.pid;
    await provider?.stop();
    await coordinator?.stop();
    claude?.stop(); modReader?.stop(); estimator?.stop(); await Promise.all([grok?.stop(), storage?.stop()]);
    if (window && !window.isDestroyed() && desktop?.attached) preferences.bounds = desktop.bounds();
    await persist();
    await store?.flush().catch(() => undefined);
    tray?.destroy(); tray = null;
    if (shutdownReceipt) {
      let childAbsent = false;
      try { if (childPid) process.kill(childPid, 0); else childAbsent = true; } catch { childAbsent = true; }
      await shutdownReceipt(childAbsent);
    }
    app.quit();
  })();
  return shutdown;
}
function senderAllowed(event: Electron.IpcMainInvokeEvent): boolean {
  return Boolean(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === 'limiter://widget/');
}
function handle(channel: string, action: (value: unknown) => unknown): void {
  ipcMain.handle(channel, (event, value: unknown) => {
    if (!senderAllowed(event)) throw new Error('Invalid widget sender');
    return action(value);
  });
}
async function startProvider(): Promise<void> {
  provider = CodexProvider.local(path.join(stateRoot, 'source'), preferences.codexPath || undefined, preferences.lastCodexPath || undefined);
  coordinator = new Coordinator(() => provider.read(), () => {
    const candidate = provider.candidate;
    if (candidate && preferences.lastCodexPath !== candidate.path) {
      preferences.lastCodexPath = candidate.path;
      void persist();
    }
    send();
  });
  provider.on('invalidate', () => coordinator.invalidate());
  provider.on('source-fault', (error: unknown) => coordinator.reportFailure(error));
  provider.on('hint', () => { void coordinator.trigger('hint'); });
  await coordinator.trigger('start');
}
async function createWidget(): Promise<void> {
  const appRoot = app.getAppPath();
  const bounds = clampBounds(preferences.bounds, screen.getAllDisplays().map(display => display.workArea));
  window = new BrowserWindow({ ...bounds,
    title: 'Limiter', frame: false, thickFrame: false, show: false, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: false, skipTaskbar: true, backgroundColor: '#151816', icon: path.join(appRoot, 'assets/tray.ico'),
    webPreferences: { preload: path.join(appRoot, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false }
  });
  desktop = new DesktopSurface(window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); hide(); } });
  // Electron emits move and resize while a native SetWindowPos call is still running on koffi's own stack. A koffi call
  // made here would start on that same stack and overwrite the running call (an access violation on x64), so only schedule.
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (window && !window.isDestroyed() && desktop?.attached) { preferences.bounds = desktop.bounds(); void persist(); } }, 300);
  };
  window.on('move', saveBounds);
  window.on('resize', saveBounds);
  window.on('closed', () => {
    resizeOrigin = null; window = null; desktop = null;
    // Explorer can destroy its child surface during a shell restart. Recreate only our window.
    if (!quitting) recreateTimer = setTimeout(() => { void createWidget().catch(() => { settingsNotice = 'Desktop unavailable; use the tray to retry.'; }); }, 1000);
  });
  await window.loadURL('limiter://widget/');
  if (desktop.attach(bounds) && !hiddenByUser) desktop.show();
}
// Toasts on Windows need a Start Menu shortcut that carries the app id; the smoke run writes it into its own profile instead.
async function ensureStartMenuShortcut(): Promise<{ path: string; appUserModelId: string | undefined }> {
  const link = testing ? path.join(stateRoot, 'Limiter.lnk') : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Limiter.lnk');
  let current: Electron.ShortcutDetails | null = null;
  try { current = shell.readShortcutLink(link); } catch { current = null; }
  if (!current || current.target !== process.execPath || current.appUserModelId !== APP_ID) {
    await fs.mkdir(path.dirname(link), { recursive: true });
    shell.writeShortcutLink(link, 'create', { target: process.execPath, cwd: path.dirname(process.execPath), appUserModelId: APP_ID, description: 'Limiter desktop usage widget' });
  }
  return { path: link, appUserModelId: shell.readShortcutLink(link).appUserModelId };
}
async function migrateLegacyState(): Promise<boolean> {
  if (testing || existsSync(path.join(stateRoot, 'settings.json')) || !existsSync(path.join(legacyStateRoot, 'settings.json'))) return false;
  await fs.mkdir(stateRoot, { recursive: true });
  for (const name of ['settings.json', 'settings.previous.json']) await fs.copyFile(path.join(legacyStateRoot, name), path.join(stateRoot, name)).catch(() => undefined);
  return true;
}
function alertRows(): AlertRow[] {
  const state = display();
  const selected = state.snapshot?.windows.find(window => window.key === state.snapshot?.selectedKey);
  const left = (used: number | null) => used === null ? null : Math.max(0, 100 - used);
  return [
    { key: 'codex', label: 'Codex weekly', left: selected?.remainingPercent ?? null, resetsAt: selected?.resetsAt ?? null, estimate: false },
    { key: 'claude-week', label: 'Claude Code weekly', left: left(state.claude.weekly.percent), resetsAt: state.claude.weekly.resetsAt, estimate: state.claude.mode === 'estimate' },
    { key: 'claude-5h', label: 'Claude Code five-hour', left: left(state.claude.fiveHour.percent), resetsAt: state.claude.fiveHour.resetsAt, estimate: state.claude.mode === 'estimate' },
    { key: 'grok', label: 'Grok weekly', left: state.grok.snapshot?.remainingPercent ?? null, resetsAt: state.grok.snapshot?.resetsAt ?? null, estimate: false }];
}
function observeAndAlert(): void {
  const rows = alertRows();
  for (const row of rows) forecast.observe(row.key, row.left === null ? null : 100 - row.left, row.resetsAt);
  for (const toast of alerts.evaluate(rows)) {
    toastsShown++;
    if (Notification.isSupported() && !testing) new Notification({ title: toast.title, body: toast.body, silent: true }).show();
  }
  if (toastsShown > 0) receiptToasts = toastsShown;
}
async function boot(): Promise<void> {
  migratedLegacyState = await migrateLegacyState();
  await fs.mkdir(stateRoot, { recursive: true });
  store = new PreferenceStore(stateRoot);
  // Every smoke run starts as a brand-new user, so the first-run path is tested each time.
  if (testing && !process.argv.includes('--smoke-child')) for (const name of ['settings.json', 'settings.previous.json', 'settings.pre-v3.json']) await fs.rm(path.join(stateRoot, name), { force: true });
  preferences = await store.load();
  firstRun = store.fresh;
  startWithWindowsState = loginItem.enabled();
  startupShortcutState = !!startupShortcut() && existsSync(startupShortcut()!);
  if (testing) { const area = screen.getPrimaryDisplay().workArea; preferences.bounds = { x: area.x + 80, y: area.y + 80, ...COMPACT_SIZE }; }
  settingsNotice = store.notice;
  await recordLaunch('start');
  nativeTheme.themeSource = preferences.theme;
  const appRoot = app.getAppPath();
  const resources = new Map([['/', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']], ['/widget.js', ['widget.js', 'text/javascript']]]);
  protocol.handle('limiter', async request => {
    const url = new URL(request.url);
    const resource = url.host === 'widget' ? resources.get(url.pathname) : undefined;
    if (!resource) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(await fs.readFile(path.join(appRoot, resource[0]))), { headers: { 'Content-Type': resource[1] + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('limiter://widget/') }));
  const clamp = () => { if (window && !window.isDestroyed() && desktop?.attached) desktop.setBounds(clampBounds(desktop.bounds(), screen.getAllDisplays().map(display => display.workArea))); };
  screen.on('display-removed', clamp);
  screen.on('display-metrics-changed', clamp);
  const icon = nativeImage.createFromPath(path.join(appRoot, 'assets/tray.ico'));
  if (icon.isEmpty()) throw new Error('Packaged tray icon unavailable');
  tray = new Tray(icon);
  tray.setToolTip('Limiter · Codex, Claude Code, Grok and disk space');
  tray.on('double-click', show);
  rebuildMenu();
  handle('limiter:state', () => display());
  handle('limiter:refresh', refresh);
  handle('limiter:theme', value => { if (!['system', 'dark', 'light'].includes(String(value))) throw new Error('Invalid theme'); theme(value as Theme); });
  handle('limiter:hide', hide);
  handle('limiter:quit', () => { void quit(); });
  handle('limiter:resize', value => {
    if (!value || typeof value !== 'object' || !('phase' in value)) throw new Error('Invalid resize request');
    if (value.phase === 'end') {
      resizeOrigin = null;
      if (desktop?.attached) { preferences.bounds = desktop.bounds(); void persist(); }
      return;
    }
    if (!desktop?.attached || !window?.isVisible()) return;
    if (value.phase === 'start') {
      if (!('edge' in value) || !resizeEdges.includes(value.edge as ResizeEdge)) throw new Error('Invalid resize edge');
      const bounds = clampBounds(desktop.bounds(), screen.getAllDisplays().map(display => display.workArea));
      resizeOrigin = { bounds, edge: value.edge as ResizeEdge, area: screen.getDisplayMatching(bounds).workArea };
      return;
    }
    if (value.phase !== 'move' || !('dx' in value) || !('dy' in value) || typeof value.dx !== 'number' || typeof value.dy !== 'number' ||
        !Number.isFinite(value.dx) || !Number.isFinite(value.dy) || Math.abs(value.dx) > 100000 || Math.abs(value.dy) > 100000) throw new Error('Invalid resize offset');
    if (!resizeOrigin) return;
    desktop.setBounds(resizeBounds(resizeOrigin.bounds, resizeOrigin.edge, value.dx, value.dy, resizeOrigin.area, COMPACT_SIZE));
    preferences.bounds = desktop.bounds();
  });
  handle('limiter:update-settings', updateSettings);
  // The renderer reports that it opened Settings for a new user, so a recreated window does not open it again.
  handle('limiter:first-run-seen', () => { firstRun = false; });
  handle('limiter:choose-folder', chooseFolder);
  handle('limiter:choose-source', async () => {
    if (!window) return;
    const choice = await dialog.showOpenDialog(window, { title: 'Choose native codex.exe', properties: ['openFile'], filters: [{ name: 'Codex executable', extensions: ['exe'] }] });
    if (choice.canceled || !choice.filePaths[0]) return;
    if (path.basename(choice.filePaths[0]).toLowerCase() !== 'codex.exe') throw new Error('Choose codex.exe');
    await provider.stop(); await coordinator.stop();
    preferences.codexPath = choice.filePaths[0];
    await persist();
    await startProvider();
  });
  // Install the coordinator before the renderer can invoke its fixed actions.
  const startup = startProvider();
  estimator = new ClaudeEstimator(send, calibration => { preferences.claudeCalibration = calibration; void persist(); }, preferences.claudeCalibration);
  // Either exact feed re-anchors the estimate, so the estimate carries on from the last exact point once a feed goes stale.
  const exactArrived = () => {
    const exact = exactClaude().state;
    if (exact.status === 'ready' && exact.sample) void estimator.observeExact(exact.sample);
    send();
  };
  claude = new ClaudeProvider(exactArrived, claudePipe() + (testing ? '-smoke' : ''));
  claude.start();
  // The smoke run reads a fixture from its own profile folder, never the real file; an earlier run's fixture is cleared first.
  if (testing) await fs.rm(path.join(stateRoot, 'claude-usage.json'), { force: true });
  modReader = new ClaudeModReader(exactArrived, testing ? [path.join(stateRoot, 'claude-usage.json')] : [defaultModFile()]);
  modReader.start();
  estimator.start();
  // The smoke run reads rollouts from its own profile folder, never the real ones; an earlier run's fixtures are cleared first.
  const rolloutsRoot = testing ? path.join(stateRoot, 'codex-sessions') : codexSessionsRoot();
  if (testing) { await fs.rm(rolloutsRoot, { recursive: true, force: true }); await fs.mkdir(rolloutsRoot, { recursive: true }); }
  codexReader = new CodexRolloutReader(rolloutsRoot);
  void scanCodexRollouts();
  codexTimer = setInterval(() => { void scanCodexRollouts(); }, SCAN_INTERVAL_MS);
  handle('limiter:calibrate-claude', value => estimator.calibrate(parseReadingInput(value, Date.now())));
  storage = new StorageProvider(send, storageConfig);
  storage.start();
  grok = new GrokProvider(send, () => preferences.grokcliRoot ? readGrokQuota(preferences.grokcliRoot) : Promise.resolve({ ok: false, status: 'setup' }));
  grok.start();
  await createWidget();
  powerMonitor.on('suspend', () => coordinator.suspend());
  powerMonitor.on('resume', () => coordinator.resume());
  // Network reads pause while the PC is idle or locked and run once more on return; local log and file reads keep going.
  gate = new ActivityGate(() => powerMonitor.getSystemIdleTime(),
    () => { coordinator.suspend(); storage.pause(); grok.pause(); },
    () => { coordinator.resume(); storage.resume(); grok.resume(); void modReader.refresh(); });
  powerMonitor.on('lock-screen', () => gate.lock());
  powerMonitor.on('unlock-screen', () => gate.unlock());
  slowTick = setInterval(() => { gate.tick(); observeAndAlert(); }, 30000);
  startMenuShortcut = await ensureStartMenuShortcut().catch(() => null);
  tick = setInterval(() => {
    coordinator.checkResets();
    if (window && !window.isDestroyed() && !desktop?.attached) {
      const bounds = clampBounds(preferences.bounds, screen.getAllDisplays().map(display => display.workArea));
      if (desktop?.attach(bounds) && !hiddenByUser) desktop.show();
    }
    if (window?.isVisible()) send();
  }, 1000);
  await startup;
  // A launch handed over from inside a package left its arguments behind for this instance.
  const pendingFile = path.join(stateRoot, 'pending-args.json');
  let pending: string[] = [];
  try { pending = relayArgs(JSON.parse(await fs.readFile(pendingFile, 'utf8'))); await fs.unlink(pendingFile); } catch { pending = []; }
  const argv = [...process.argv, ...pending];
  if (argv.some(arg => arg.startsWith('--claude-weekly='))) await calibrateFromArgs(argv);
  if (pending.includes('--diagnose')) await diagnostic();
  if (process.argv.includes('--diagnose')) await diagnostic();
  if (process.argv.includes('--smoke-test')) await smoke();
}
async function smoke(): Promise<void> {
  const receipt: Record<string, unknown> = { scope: 'actual portable Limiter executable', executable: process.execPath, version: app.getVersion(), packaged: app.isPackaged, arch: process.arch, modelTurnsStarted: 0 };
  // The receipt sits next to the smoke profile, so each architecture and run keeps its own.
  const directory = path.dirname(stateRoot);
  await fs.mkdir(directory, { recursive: true });
  try {
    if (!window) throw new Error('Window absent');
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    while ((!coordinator.snapshot || coordinator.status !== 'ready') && performance.now() - startedAt < 20000 && !['compatibility', 'signed-out'].includes(coordinator.status)) await wait(200);
    await wait(350);
    if (!coordinator.snapshot || coordinator.status !== 'ready') throw new Error('Fresh quota absent');
    const firstReadyMs = performance.now() - startedAt;
    const source = provider.candidate;
    const first = display();
    const isolation = await window.webContents.executeJavaScript('({ node: typeof require, process: typeof process, bridge: Object.keys(window.limiter), ready: document.body.dataset.ready, percent: document.getElementById("percent").textContent, titlebarDrag: getComputedStyle(document.querySelector(".titlebar")).webkitAppRegion, horizontalOverflow: document.documentElement.scrollWidth > innerWidth, verticalOverflow: document.documentElement.scrollHeight > innerHeight, innerWidth, innerHeight, contentHeight: document.documentElement.scrollHeight, devicePixelRatio })');
    if (isolation.node !== 'undefined' || isolation.process !== 'undefined' || isolation.ready !== 'true' || isolation.horizontalOverflow || isolation.verticalOverflow) throw new Error('Renderer boundary or layout failed');
    // A brand-new profile opens Settings once so the user can set folders and disks.
    const firstRunPanel = await window.webContents.executeJavaScript('({open:!document.getElementById("details").hidden,settings:!document.getElementById("settings").hidden})');
    if (!store.fresh || firstRun || !firstRunPanel.open || !firstRunPanel.settings) throw new Error('A fresh profile did not open Settings once');
    await window.webContents.executeJavaScript('document.getElementById("close-details").click()');
    receipt.firstRun = firstRunPanel;
    const selected = first.snapshot?.windows.find(item => item.key === first.snapshot?.selectedKey);
    if (selected?.remainingPercent !== null && selected?.remainingPercent !== undefined && isolation.percent !== String(selected.remainingPercent) + '% left') throw new Error('Displayed remaining percentage disagrees with source snapshot');
    const native = desktop!.inspect();
    if (!native.attached || !native.childStyle || native.topmost || !['Progman', 'WorkerW'].includes(String(native.rootClass))) throw new Error('Not attached to the desktop');
    const cover = new BrowserWindow({ ...desktop!.bounds(), title: 'Limiter verification cover', show: false, frame: false, skipTaskbar: true, backgroundColor: '#253021',
      webPreferences: { partition: 'limiter-verification-cover', sandbox: true, nodeIntegration: false, contextIsolation: true } });
    let covered = false;
    // The Windows lock screen sits above every window, so overlap and focus cannot be observed while it is up.
    let lockedScreen = false;
    try {
      await cover.loadURL('data:text/html,<body style="margin:0;background:%23253021">Limiter verification</body>');
      cover.showInactive(); cover.moveTop(); await wait(300);
      covered = desktop!.coveredByNormalApp();
      const occlusion = desktop!.occlusionReceipt(cover);
      receipt.occlusion = occlusion;
      receipt.coveredByTestWindow = desktop!.coveredBy(cover);
      // Two lock-screen shapes appear on Windows 11: the backstop frame, and LockApp's topmost CoreWindow.
      const occlusionText = JSON.stringify(occlusion);
      lockedScreen = !covered && (occlusionText.includes('LockScreenBackstopFrame') || (occlusionText.includes('"hitRootClass":"Windows.UI.Core.CoreWindow"') && occlusionText.includes('"hitRootTopmost":true')));
      if (lockedScreen) receipt.unverifiedWhileLocked = ['normal app covers widget', 'restore keeps foreground'];
      else if (!covered || cover.isAlwaysOnTop()) throw new Error('A normal app window did not cover the desktop widget');
    } finally { cover.destroy(); }
    const foreground = desktop!.foreground();
    await window.webContents.executeJavaScript('window.limiter.hide()');
    if (window.isVisible()) throw new Error('Hide control failed');
    trayMenu.getMenuItemById('show')!.click(null!, window, {} as Electron.KeyboardEvent);
    if (!window.isVisible()) throw new Error('Tray restore failed');
    const beforeBounds = desktop!.bounds();
    desktop!.setBounds({ ...beforeBounds, x: beforeBounds.x - 20, y: beforeBounds.y + 20 });
    const moved = desktop!.bounds();
    if (moved.x === beforeBounds.x && moved.y === beforeBounds.y) throw new Error('Window move failed');
    desktop!.setBounds(beforeBounds);
    await storage.refresh();
    const storageView = storage.state();
    const readStorageUi = () => window!.webContents.executeJavaScript('({local:document.getElementById("local-free").textContent,localLabel:document.getElementById("local-label").textContent,remoteHidden:document.getElementById("remote-card").hidden,grokHidden:document.getElementById("grok-card").hidden,missingBilling:!document.getElementById("xai-card"),fits:[...document.querySelectorAll(".disk-row")].filter(el=>!el.closest(".card").hidden).every(el=>el.scrollWidth<=el.clientWidth)})');
    const storageUi = await readStorageUi();
    const localReading = storageView.local.reading;
    // Fresh profile: one local disk named after the PC, no remote disk and no Grok row.
    if (!storageUi.missingBilling || !storageUi.fits || !localReading || storageView.local.status !== 'ready' || storageUi.local !== formatDiskBytes(localReading.freeBytes) + ' free' ||
        storageUi.localLabel !== os.hostname() || storageView.remote.status !== 'off' || !storageUi.remoteHidden || !storageUi.grokHidden)
      throw new Error('Fresh-profile rows are wrong: ' + JSON.stringify({ storageUi, local: storageView.local.status, remote: storageView.remote.status }));
    // Configured: a saved disk name shows at once, and a host that could become an ssh option is refused.
    await updateSettings({ localDiskLabel: 'Smoke PC' });
    await wait(200);
    const renamed = await readStorageUi();
    if (renamed.localLabel !== 'Smoke PC' || preferences.localDiskLabel !== 'Smoke PC') throw new Error('Saved disk name did not apply');
    const hostileRefused = await updateSettings({ remoteDisk: { host: '-oProxyCommand=calc', label: 'x' } }).then(() => false, () => true);
    if (!hostileRefused || preferences.remoteDisk !== null) throw new Error('An option-shaped SSH host was accepted');
    // Start with Windows goes through the in-memory adapter during the smoke; no Run value is written.
    await updateSettings({ startWithWindows: true });
    const startOn = configView().startWithWindows;
    await updateSettings({ startWithWindows: false });
    if (!startOn || configView().startWithWindows || smokeLoginOs.calls.length !== 2 || smokeLoginOs.calls.some(call => call.path !== process.execPath)) throw new Error('Start-with-Windows toggle failed');
    receipt.storage = { ...storageView, fresh: storageUi, renamed: renamed.localLabel, hostileRefused, startWithWindowsCalls: smokeLoginOs.calls };
    const rows = await window.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('main');
      const cards = [...list.querySelectorAll(':scope > .card')].filter(card => !card.hidden);
      list.scrollTop = list.scrollHeight;
      const bottom = cards.at(-1).getBoundingClientRect();
      const visible = list.getBoundingClientRect();
      const lastReachable = bottom.top >= visible.top - 1 && bottom.bottom <= visible.bottom + 1;
      list.scrollTop = 0;
      return { heights: cards.map(card => card.getBoundingClientRect().height), fonts: cards.map(card => getComputedStyle(card.querySelector('strong')).fontSize), lastReachable };
    })()`);
    if (rows.heights.length !== 3 || !rows.lastReachable || new Set(rows.heights).size !== 1 || new Set(rows.fonts).size !== 1) throw new Error('Widget rows differ in size or are unreachable');
    receipt.rows = rows;
    for (const name of ['codex', 'claude', 'local']) {
      await window.webContents.executeJavaScript('document.getElementById("' + name + '-card").click()');
      const panel = await window.webContents.executeJavaScript('({hidden:document.getElementById("details").hidden,text:document.getElementById("details-content").textContent,overflow:document.getElementById("details").scrollWidth>document.getElementById("details").clientWidth})');
      if (panel.hidden || !panel.text || panel.overflow) throw new Error('Provider detail panel failed');
      await window.webContents.executeJavaScript('document.getElementById("close-details").click()');
    }
    // Enter a reading through the real renderer bridge; an estimate taken at that moment must equal it.
    await window.webContents.executeJavaScript('window.limiter.calibrateClaude({ weeklyPercent: "50", weeklyResetsIn: "3d", fiveHourPercent: "", fiveHourResetsIn: "" })');
    const calibrated = display().claude;
    if (calibrated.mode === 'unavailable' || (calibrated.coverage.replies > 0 && (calibrated.mode !== 'estimate' || Math.abs((calibrated.weekly.percent ?? -1) - 50) > 1)))
      throw new Error('Claude reading did not produce a matching estimate: ' + JSON.stringify({ mode: calibrated.mode, weekly: calibrated.weekly, exact: calibrated.exact, anchor: calibrated.anchor, modState: modReader.state().status }));
    const shownClaude = await window.webContents.executeJavaScript('document.getElementById("claude-percent").textContent');
    if (calibrated.mode === 'estimate' && !/^≈\d+(\.\d)?% left$/.test(shownClaude)) throw new Error('Claude card does not show the estimated remaining capacity');
    receipt.claudeEstimate = { mode: calibrated.mode, weeklyUsedPercent: calibrated.weekly.percent, shown: shownClaude, replies: calibrated.coverage.replies, unknownModels: calibrated.coverage.unknownModels };
    // A mod file written into the profile must flip the row to exact, with no ≈ mark, and re-anchor the estimate.
    const fixtureReset = new Date(Date.now() + 3 * 3600000).toISOString();
    await fs.writeFile(path.join(stateRoot, 'claude-usage.json'), JSON.stringify({ schemaVersion: 1, source: 'claude-code-mod', host: 'SMOKE', observedAt: Date.now(),
      rateLimits: [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: fixtureReset }, { kind: 'seven_day', percentUsed: 61, resetsAt: fixtureReset }] }) + '\n');
    await modReader.refresh();
    await wait(200);
    const exactView = display().claude;
    const shownExact = await window.webContents.executeJavaScript('document.getElementById("claude-percent").textContent');
    if (exactView.mode !== 'exact' || exactView.exact?.source !== 'mod' || exactView.weekly.percent !== 61 || shownExact !== '39% left') throw new Error('Mod file did not produce an exact Claude reading');
    receipt.claudeExact = { mode: exactView.mode, source: exactView.exact?.source, host: exactView.exact?.host, shown: shownExact, anchor: exactView.anchor };
    // One synthetic Codex session written twice, plain and compressed, must count once under its project with exact tokens.
    const rolloutDirectory = path.join(stateRoot, 'codex-sessions', 'smoke');
    const projectsFixture = path.join(stateRoot, 'projects-fixture');
    const sessionFolder = path.join(projectsFixture, 'SmokeProject', 'src');
    await fs.mkdir(sessionFolder, { recursive: true });
    await fs.mkdir(rolloutDirectory, { recursive: true });
    const counts = (input: number, cached: number, output: number, reasoning: number) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
      output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
    const rolloutAt = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();
    const rollout = [
      { timestamp: rolloutAt(90000), type: 'session_meta', payload: { id: 'smoke-session', session_id: 'smoke-session', cwd: sessionFolder } },
      { timestamp: rolloutAt(60000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: counts(1000, 400, 50, 20) } } },
      { timestamp: rolloutAt(30000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: counts(3000, 1400, 120, 60) } } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n';
    await fs.writeFile(path.join(rolloutDirectory, 'plain.jsonl'), rollout);
    await fs.writeFile(path.join(rolloutDirectory, 'copy.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(rollout)));
    await scanCodexRollouts();
    await wait(200);
    // Without a projects folder the session counts under its own folder name; with one, under its first-level folder.
    const ungrouped = display().projects.codex.rows[0]?.name;
    if (ungrouped !== 'src') throw new Error('Without a projects folder the session should count as src, got ' + ungrouped);
    await updateSettings({ projectsRoot: projectsFixture });
    await wait(200);
    const projectState = display().projects;
    const codexLeader = projectState.codex.rows[0];
    const codexCoverage = projectState.codex.coverage;
    // 600 uncached x 1.25 + 400 cached x 0.125 + 50 output x 10, then 1,000 x 1.25 + 1,000 x 0.125 + 70 x 10.
    if (!codexLeader || codexLeader.name !== 'SmokeProject' || codexLeader.share !== 100 || codexLeader.tokens !== 3120 || Math.round(codexLeader.units * 1e6) !== 3375 ||
        codexCoverage?.files !== 2 || codexCoverage.read !== 2 || codexCoverage.sessions !== 1 || codexCoverage.skipped !== 0 || projectState.codex.status !== 'ok')
      throw new Error('Codex project ranking did not count the fixture session once: ' + JSON.stringify({ rows: projectState.codex.rows, coverage: codexCoverage }));
    const claudeReplies = display().claude.coverage.replies;
    if (claudeReplies > 0 && !projectState.claude.rows.length) throw new Error('Claude project ranking is empty although replies were read');
    const metaFit = await window.webContents.executeJavaScript('["codex-meta","claude-meta"].map(id => { const span = document.getElementById(id); return { id, text: span.textContent, clipped: span.scrollWidth > span.clientWidth }; })');
    if (metaFit.some((item: { text: string; clipped: boolean }) => item.clipped && / · \S.* \d+(\.\d)?%$/.test(item.text))) throw new Error('A leader tag was clipped on a row meta line');
    await window.webContents.executeJavaScript('document.getElementById("codex-card").click()');
    const projectPanel = await window.webContents.executeJavaScript('({text:document.getElementById("details-content").textContent,overflow:document.getElementById("details").scrollWidth>document.getElementById("details").clientWidth})');
    await window.webContents.executeJavaScript('document.getElementById("close-details").click()');
    if (!projectPanel.text.startsWith('By project this weekSmokeProject · 100% · 3k tokens') || projectPanel.overflow) throw new Error('Codex panel does not open with the fixture project list: ' + projectPanel.text.slice(0, 80));
    if (!metaFit.find((item: { id: string; text: string }) => item.id === 'codex-meta')?.text.endsWith(' · SmokeProject 100%')) throw new Error('Codex row line does not name its top project');
    receipt.projects = { codex: { leader: codexLeader, coverage: codexCoverage, window: projectState.codex.window }, claude: { rows: projectState.claude.rows.length, leader: projectState.claude.rows[0]?.name ?? null, replies: claudeReplies, window: projectState.claude.window },
      metaFit, codexReads: codexReader.counts };
    // Alerts, pace and the toast prerequisites are exercised here; a real toast is never shown during a smoke run.
    observeAndAlert();
    const lowRows = alertRows().map(row => ({ ...row, left: 4 }));
    // A fresh tracker, because the live pass above may already have fired for rows that really are low.
    const toasts = new AlertTracker().evaluate(lowRows);
    if (toasts.length !== lowRows.filter(row => row.resetsAt !== null).length * 2) throw new Error('Low-capacity alerts did not fire once per threshold');
    const paceShown = await window.webContents.executeJavaScript('({ marker: document.getElementById("claude-pace").hidden, meta: document.getElementById("claude-meta").textContent })');
    receipt.alerts = { toastsSupported: Notification.isSupported(), toastsEvaluated: toasts.length, startMenuShortcut, paceShown, gatePaused: gate.paused, migratedLegacyState,
      launchGuard: { insidePackage: insidePackage(), startedByAgent: startedByAgent(), wouldRelaunch: sandboxed } };
    receipt.grok = { status: display().grok.status, remainingPercent: display().grok.snapshot?.remainingPercent ?? null };
    for (const value of ['dark', 'light'] as const) {
      await window.webContents.executeJavaScript('window.limiter.theme("' + value + '")');
      await wait(150);
      for (const factor of [1, 1.5]) {
        window.webContents.setZoomFactor(factor);
        await wait(100);
        const overflow = await window.webContents.executeJavaScript('document.documentElement.scrollWidth > innerWidth');
        // Chromium zoom is not Windows DPI; a dedicated launch checks the OS scale path.
        if (factor === 1 && overflow) throw new Error('Layout overflow');
      }
      window.webContents.setZoomFactor(1);
      await wait(100);
      await fs.writeFile(path.join(directory, 'widget-' + value + '.png'), (await window.webContents.capturePage()).toPNG());
    }
    theme('system');
    const duplicate = spawn(process.execPath, ['--smoke-child', ...(smokeProfile ? ['--smoke-profile=' + smokeProfile] : [])], { windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { duplicate.once('error', reject); duplicate.once('exit', code => code === 0 ? resolve() : reject(new Error('Duplicate launch failed'))); });
    await wait(200);
    if (duplicateLaunches !== 1) throw new Error('Single-instance restore failed');
    if ((!lockedScreen && desktop!.foreground() !== foreground) || window.isAlwaysOnTop() || !desktop!.attached) throw new Error('Restore stole focus or left the desktop layer');
    const requestsBefore = provider.counts.quotaReads;
    await wait(Math.max(0, coordinator.cooldownMs) + 50);
    await window.webContents.executeJavaScript('window.limiter.refresh()');
    await wait(200);
    // An idle or locked PC pauses network reads (the activity gate), so a manual read cannot be observed then; record it, never pass it.
    if (gate.paused) receipt.unverifiedWhilePaused = ['manual refresh reads quota once'];
    else if (provider.counts.quotaReads !== requestsBefore + 1) throw new Error('Manual refresh count failed');
    const metricsBefore = app.getAppMetrics();
    const idleRequests = provider.counts.quotaReads;
    await fs.writeFile(path.join(directory, 'measurement-ready.json'), JSON.stringify({ pids: [...metricsBefore.map(metric => metric.pid), provider.pid].filter(Boolean) }));
    await wait(13000);
    const metricsAfter = app.getAppMetrics();
    if (provider.counts.quotaReads !== idleRequests) throw new Error('Unexpected idle reads');
    const childPid = provider.pid;
    const finalState = display();
    await persist();
    const saved = JSON.parse(await fs.readFile(path.join(stateRoot, 'settings.json'), 'utf8'));
    if (Object.keys(saved).some(key => /quota|account|token|snapshot|email/i.test(key))) throw new Error('Private data in preferences');
    receipt.result = 'PASS';
    Object.assign(receipt, { source, firstReadyMs, first, finalState, isolation, desktop: native, normalAppCoveredWidget: covered, restoreKeptForeground: !lockedScreen, moved, tray: 'Show and Quit menu handlers, renderer hide/refresh, provider details, duplicate restore exercised', duplicateLaunches, counts: provider.counts, childPid, metricsBefore, metricsAfter, preferenceKeys: Object.keys(saved) });
  } catch (error) {
    receipt.result = 'FAIL';
    receipt.status = coordinator?.status;
    receipt.source = provider?.candidate;
    receipt.counts = provider?.counts;
    receipt.reason = error instanceof Error ? error.message : 'Packaged smoke failed';

  } finally {
    shutdownReceipt = async childAbsent => {
      receipt.childAbsent = childAbsent;
      if (!childAbsent) { receipt.result = 'FAIL'; receipt.reason = 'Owned child remained after tray Quit'; }
      await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
      console.log(JSON.stringify({ result: receipt.result, reason: receipt.reason, childAbsent }));
    };
    trayMenu.getMenuItemById('quit')!.click(null!, window, {} as Electron.KeyboardEvent);
    await shutdown;
  }
}
const relay = relayArgs(process.argv);
const sandboxed = !testing && (insidePackage() || startedByAgent());
const shortcut = startupShortcut();
if (wrongBuild) {
  // Point an ARM64 PC at the ARM64 download instead of crashing in x64 emulation (GUARDRAILS rule 49).
  if (testing) { console.error('Limiter x64 build on an ARM64 PC: use the ARM64 build'); app.exit(3); }
  else void app.whenReady().then(async () => {
    const choice = dialog.showMessageBoxSync({ type: 'info', title: 'Limiter', buttons: ['Open the download page', 'Close'], defaultId: 0, cancelId: 1,
      message: 'This is the x64 build of Limiter, and this PC has an ARM64 processor.', detail: 'Download the ARM64 zip instead, from ' + DOWNLOAD_PAGE });
    if (choice === 0) await shell.openExternal(DOWNLOAD_PAGE).catch((error: unknown) => console.error('Download page did not open: ' + String(error)));
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
else if (process.argv.includes('--quit')) app.quit();
else if (sandboxed && shortcut && existsSync(shortcut)) {
  // Started inside an app package with no instance running: hand the launch, and any reading, to Explorer.
  try { mkdirSync(stateRoot, { recursive: true }); if (relay.length) writeFileSync(path.join(stateRoot, 'pending-args.json'), JSON.stringify(relay)); } catch { /* The reading is lost, the launch still goes on. */ }
  app.releaseSingleInstanceLock();
  spawn('explorer.exe', [shortcut], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  app.exit(0);
} else {
  app.on('second-instance', (_event, args) => {
    if (args.includes('--quit')) { void quit(); return; }
    if (args.includes('--diagnose')) { void diagnostic(); return; }
    if (args.some(arg => arg.startsWith('--claude-weekly='))) { void calibrateFromArgs(args); return; }
    duplicateLaunches++; void recordLaunch('second'); show();
  });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => undefined);
  void app.whenReady().then(boot).catch(async (error: unknown) => {
    await recordLaunch('boot-error', error instanceof Error ? error.message : String(error));
    if (testing) console.error('Limiter startup failed');
    else dialog.showErrorBox('Limiter could not start', 'The local widget could not start. Check the portable package and try again.');
    await provider?.stop();
    quitting = true;
    app.exit(1);
  });
}
