import { ageLabel, countdown, resetLabel, windowLabel, type DisplayState, type Theme } from '../shared/usage.js';
import { FIVE_HOUR_MS, WEEK_MS, paceOf, type Pace } from '../shared/pace.js';
import { installResize } from './resize.js';
import { compactDiskBytes, diskIds, formatDiskBytes, type StorageState } from '../shared/storage.js';

installResize(request => window.limiter.resize(request));

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing widget element: ' + id);
  return value as T;
}
const labels: Record<DisplayState['status'], string> = {
  loading:'Connecting', ready:'Current read', 'signed-out':'Sign in needed', offline:'Offline',
  throttled:'Cooling down', timeout:'Read timed out', unavailable:'Unavailable', compatibility:'Update needed'
};
const claudeLabels: Record<DisplayState['claude']['mode'], string> = {
  exact:'Exact reading', estimate:'Estimate', uncalibrated:'Open to enter a reading', scanning:'Reading local logs', unavailable:'No Claude Code logs found'
};
const grokLabels: Record<DisplayState['grok']['status'], string> = {
  setup:'Set up grokcli', loading:'Connecting', ready:'Current read', 'signed-out':'Sign in to grokcli', offline:'Offline',
  unauthorized:'Plan not eligible', throttled:'Cooling down', timeout:'Read timed out', compatibility:'Source changed'
};
const antigravityLabels: Record<DisplayState['antigravity']['status'], string> = {
  absent:'Not installed', closed:'Open Antigravity to refresh', loading:'Connecting', ready:'Current read', 'signed-out':'Sign in to Antigravity',
  timeout:'Read timed out', compatibility:'Source changed'
};
const periodNames = { weekly: { short:'week', long:'Weekly' }, monthly: { short:'month', long:'Monthly' }, daily: { short:'day', long:'Daily' }, unknown: { short:'sub', long:'Period' } };
let current: DisplayState | null = null;
// Formats a reset or run-out time in the zone the main process resolved, which can differ from this window's ICU default.
function reset(epochSeconds: number | null): string { return resetLabel(epochSeconds, current?.timeZone); }
let panel: 'codex' | 'claude' | 'grok' | 'antigravity' | 'storage' | 'settings' | null = null;
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_CIRCUMFERENCE = 2 * Math.PI * 20;
const INNER_RADIUS = 14.5;
const INNER_CIRCUMFERENCE = 2 * Math.PI * INNER_RADIUS;
const ringPercent = (value: number | null) => value === null ? '··' : String(Math.round(value)) + '%';
const percent = (value: number | null) => value === null ? '··' : String(Math.round(value * 10) / 10) + '%';
const remaining = (used: number | null) => used === null ? null : Math.max(0, 100 - used);
function renderStorage(state: StorageState): void {
  for (const id of diskIds) {
    const { reading, status } = state[id];
    const value = reading ? compactDiskBytes(reading.freeBytes) : '··';
    const full = reading ? formatDiskBytes(reading.freeBytes) + ' free of ' + formatDiskBytes(reading.totalBytes) : status === 'waiting' ? 'Checking' : 'Unavailable';
    const card = element(id + '-card');
    // A remote disk with no host set is off, so its tile is hidden.
    card.hidden = status === 'off';
    card.dataset.stale = String(status === 'stale');
    element(id + '-label').textContent = state[id].label;
    element(id + '-volume').textContent = reading ? (status === 'stale' ? state[id].volume + ' · stale' : state[id].volume + ' free') : status === 'waiting' ? 'Checking…' : 'Unavailable';
    element(id + '-free').textContent = value;
    const left = reading ? 100 * reading.freeBytes / reading.totalBytes : null;
    meter(id + '-meter', id + '-fill', left);
    const label = state[id].label + ' ' + state[id].volume + ': ' + full + '. Open disk details.';
    card.title = label;
    card.setAttribute('aria-label', label);
  }
}
function meter(id: string, fill: string, left: number | null, pace: Pace | null = null, marker: string | null = null): void {
  const arc = element(fill);
  const clamped = left === null ? 0 : Math.max(0, Math.min(100, left));
  const on = left === null || clamped <= 0 ? 0 : RING_CIRCUMFERENCE * clamped / 100;
  arc.setAttribute('stroke-dasharray', on.toFixed(2) + ' ' + RING_CIRCUMFERENCE.toFixed(2));
  arc.style.opacity = on > 0 ? '1' : '0';
  const bar = element(id);
  if (left === null) bar.removeAttribute('aria-valuenow'); else bar.setAttribute('aria-valuenow', String(clamped));
  bar.dataset.tone = left !== null && left <= 5 ? 'bad' : left !== null && left <= 20 ? 'warn' : 'good';
  // The tick marks where the ring would end if use tracked time evenly; an arc shorter than it is ahead of pace.
  if (marker) {
    const tick = element(marker);
    // SVG elements have no hidden property, so the attribute itself is toggled; setting .hidden left every tick hidden in 0.8.0.
    tick.toggleAttribute('hidden', !pace);
    if (pace) {
      const evenLeft = Math.max(0, Math.min(100, 100 - pace.elapsedPercent));
      const angle = 2 * Math.PI * evenLeft / 100;
      const c = 23, inner = 16, outer = 24;
      tick.setAttribute('x1', (c + Math.cos(angle) * inner).toFixed(2));
      tick.setAttribute('y1', (c + Math.sin(angle) * inner).toFixed(2));
      tick.setAttribute('x2', (c + Math.cos(angle) * outer).toFixed(2));
      tick.setAttribute('y2', (c + Math.sin(angle) * outer).toFixed(2));
    }
  }
}
const paceTag = (pace: Pace | null) => pace && pace.label !== 'on pace' ? ' · ' + pace.label : '';
const projectName = (name: string) => name.length > 18 ? name.slice(0, 17) + '…' : name;
const compactTokens = (value: number) => value >= 1e6 ? (Math.round(value / 1e5) / 10) + 'M' : value >= 1e3 ? Math.round(value / 1e3) + 'k' : String(Math.round(value));
function projectLines(view: DisplayState['projects']['claude'], text: (value: string, heading?: boolean) => void): void {
  text('By project · weighted local usage', true);
  if (!view.rows.length) text(view.coverage === null && view.totalUnits === 0 ? 'No project usage recorded in this window yet.' : 'No project usage in this window.');
  for (const row of view.rows) text(projectName(row.name) + ' · ' + row.share + '% · ' + compactTokens(row.tokens) + ' tokens');
  if (view.status === 'degraded' && view.coverage) text(view.coverage.unreadable + ' sessions unreadable, ' + view.coverage.skipped + ' skipped, ' + view.coverage.malformedLines + ' malformed lines.');
}
function forecastText(view: DisplayState['forecast'][keyof DisplayState['forecast']]): string | null {
  if (!view) return null;
  if (view.pastReset || view.emptyAt === null) return 'At the last hour\'s pace it lasts past the reset.';
  return 'At the last hour\'s pace it runs out at ' + reset(Math.floor(view.emptyAt / 1000)) + '.';
}
// Antigravity reports a weekly and a 5-hour quota per model group and the group count can change, so its tiles are built here,
// before the disk tiles. The outer ring is the weekly limit and the inner ring the 5-hour limit.
function antigravityCard(index: number): HTMLElement {
  const id = 'ag-' + index;
  const existing = document.getElementById(id + '-card');
  if (existing) return existing;
  const node = (tag: string, className = '', nodeId = '') => { const made = document.createElement(tag); if (className) made.className = className; if (nodeId) made.id = nodeId; return made; };
  const svgNode = (tag: string, className = '', nodeId = '') => { const made = document.createElementNS(SVG_NS, tag); if (className) made.setAttribute('class', className); if (nodeId) made.id = nodeId; return made; };
  const card = node('button', 'card ring-tile antigravity-card', id + '-card');
  const ring = node('span', 'ring', id + '-meter');
  ring.setAttribute('role', 'progressbar'); ring.setAttribute('aria-valuemin', '0'); ring.setAttribute('aria-valuemax', '100');
  const svg = svgNode('svg');
  svg.setAttribute('viewBox', '0 0 46 46'); svg.setAttribute('width', '46'); svg.setAttribute('height', '46'); svg.setAttribute('aria-hidden', 'true');
  for (const [circle, radius] of [[svgNode('circle', 'track'), 20], [svgNode('circle', 'arc antigravity', id + '-fill'), 20],
    [svgNode('circle', 'track inner'), INNER_RADIUS], [svgNode('circle', 'arc inner', id + '-inner'), INNER_RADIUS]] as const) {
    circle.setAttribute('cx', '23'); circle.setAttribute('cy', '23'); circle.setAttribute('r', String(radius));
    svg.append(circle);
  }
  ring.append(svg, node('strong', '', id + '-percent'));
  const labels = node('span', 'tile-label');
  labels.append(node('span', 'tile-name', id + '-pool'), node('small', '', id + '-meta'));
  card.append(ring, labels);
  card.addEventListener('click', () => openPanel('antigravity'));
  element('local-card').before(card);
  return card;
}
// The inner ring has its own length and its own warning colour, so it does not take the outer ring's tone.
function innerMeter(fill: string, left: number | null): void {
  const arc = element(fill);
  const clamped = left === null ? 0 : Math.max(0, Math.min(100, left));
  const on = clamped <= 0 ? 0 : INNER_CIRCUMFERENCE * clamped / 100;
  arc.setAttribute('stroke-dasharray', on.toFixed(2) + ' ' + INNER_CIRCUMFERENCE.toFixed(2));
  arc.style.opacity = on > 0 ? '1' : '0';
  arc.setAttribute('data-tone', left !== null && left <= 5 ? 'bad' : left !== null && left <= 20 ? 'warn' : 'good');
}
const bucketPassed = (bucket: { resetsAt: number | null } | null) => !!bucket && bucket.resetsAt !== null && bucket.resetsAt * 1000 <= Date.now();
function renderAntigravity(state: DisplayState['antigravity']): void {
  const snap = state.snapshot;
  const pools = snap?.pools || [];
  // No install, or the first read still running, hides the tiles, so a PC without Antigravity never flashes one; after that,
  // no reading shows one tile with the status.
  const count = state.status === 'absent' || (state.status === 'loading' && !snap) ? 0 : Math.max(1, pools.length);
  for (let index = 0; index < count; index++) {
    const id = 'ag-' + index;
    const card = antigravityCard(index);
    const pool = pools[index];
    const weekly = pool?.weekly ?? null, fiveHour = pool?.fiveHour ?? null;
    const passed = bucketPassed(weekly) || bucketPassed(fiveHour);
    const weeklyLeft = !weekly || bucketPassed(weekly) ? null : weekly.remainingPercent;
    const fiveLeft = !fiveHour || bucketPassed(fiveHour) ? null : fiveHour.remainingPercent;
    card.hidden = false;
    // A reading kept from a closed app is greyed and carries its age until a reset passes.
    card.dataset.stale = String(!!pool && state.stale && !passed);
    element(id + '-pool').textContent = pool?.name || 'Antigravity';
    element(id + '-percent').textContent = ringPercent(weeklyLeft);
    meter(id + '-meter', id + '-fill', weeklyLeft);
    innerMeter(id + '-inner', fiveLeft);
    element(id + '-meter').setAttribute('aria-label', 'Antigravity ' + (pool?.name || 'plan') + ' weekly quota remaining');
    const meta = !pool ? (state.status === 'ready' ? 'No quota' : antigravityLabels[state.status]) :
      passed && state.status === 'closed' ? 'Open Antigravity' :
      state.stale && snap && !passed ? 'Stale · ' + ageLabel(Date.now() - snap.observedAt).replace('Read ', '') :
      '5h ' + ringPercent(fiveLeft);
    element(id + '-meta').textContent = meta;
    const label = 'Antigravity ' + (pool?.name || 'plan') + ': ' + (!pool ? meta :
      'weekly ' + (weeklyLeft === null ? 'unknown' : percent(weeklyLeft) + ' left') + ', 5-hour ' + (fiveLeft === null ? 'unknown' : percent(fiveLeft) + ' left') +
      (state.stale && !passed ? ', stale' : '')) + '. Open details.';
    card.title = label;
    card.setAttribute('aria-label', label);
  }
  for (let index = count; document.getElementById('ag-' + index + '-card'); index++) element('ag-' + index + '-card').hidden = true;
}
function render(state: DisplayState): void {
  current = state;
  const selected = state.snapshot?.windows.find(window => window.key === state.snapshot?.selectedKey);
  const expired = selected?.resetsAt != null && selected.resetsAt * 1000 <= Date.now();
  const left = expired ? null : selected?.remainingPercent ?? null;
  document.documentElement.dataset.theme = state.theme;
  element<HTMLSelectElement>('theme').value = state.theme;
  element('percent').textContent = ringPercent(left);
  const codexPace = paceOf(expired ? null : selected?.usedPercent ?? null, selected?.resetsAt ?? null, (selected?.durationMins ?? 10080) * 60000);
  meter('meter', 'fill', left, codexPace, 'codex-pace');
  const codexStatus = expired ? 'Awaiting reset' : selected?.restricted ? 'Account restricted' : state.stale ? 'Stale sample' : state.status !== 'ready' ? labels[state.status] :
    left !== null ? 'Weekly remaining' : state.snapshot?.selection === 'ambiguous' ? 'Multiple limits, see details' : 'Weekly limit unavailable';
  element('codex-meta').textContent = codexStatus === 'Weekly remaining'
    ? (selected?.resetsAt ? countdown(selected.resetsAt).replace('Resets in ', '') : 'week')
    : codexStatus;
  const codexLeader = state.projects.codex.rows[0];
  const codexTitle = 'Codex: ' + (left === null ? codexStatus : percent(left) + ' left') + paceTag(codexPace) + (codexLeader && codexLeader.share > 0 ? ' · ' + projectName(codexLeader.name) + ' ' + codexLeader.share + '%' : '') + '. Open details.';
  element('codex-card').title = codexTitle;
  element('codex-card').setAttribute('aria-label', codexTitle);
  const claude = state.claude;
  // The approximately-equal sign marks every estimated number, so it is never mistaken for an account reading.
  const mark = claude.mode === 'estimate' ? '≈' : '';
  const weekly = remaining(claude.weekly.percent);
  element('claude-percent').textContent = weekly === null ? '··' : mark + ringPercent(weekly);
  const claudePace = paceOf(claude.weekly.percent, claude.weekly.resetsAt, WEEK_MS);
  meter('claude-meter', 'claude-fill', weekly, claudePace, 'claude-pace');
  const claudeStatus = weekly !== null ? 'Remaining · ' + (claude.mode === 'exact' ? 'exact' : 'est.') : claudeLabels[claude.mode];
  element('claude-meta').textContent = weekly === null ? claudeLabels[claude.mode]
    : claude.mode === 'estimate' ? 'estimate'
    : claude.fiveHour.percent !== null ? '5h ' + ringPercent(remaining(claude.fiveHour.percent)) : 'week';
  const claudeLeader = state.projects.claude.rows[0];
  const claudeTitle = 'Claude Code: ' + (weekly === null ? claudeStatus : mark + percent(weekly) + ' left') + (claude.fiveHour.percent !== null ? ' (5h ' + mark + percent(remaining(claude.fiveHour.percent)) + ' left)' : '') +
    (weekly !== null ? paceTag(claudePace) : '') + (claudeLeader && claudeLeader.share > 0 ? ' · ' + projectName(claudeLeader.name) + ' ' + claudeLeader.share + '%' : '') + '. Open details.';
  element('claude-card').title = claudeTitle;
  element('claude-card').setAttribute('aria-label', claudeTitle);
  const grok = state.grok;
  const grokExpired = grok.snapshot?.resetsAt != null && grok.snapshot.resetsAt * 1000 <= Date.now();
  const grokLeft = grokExpired ? null : grok.snapshot?.remainingPercent ?? null;
  element('grok-percent').textContent = ringPercent(grokLeft);
  const grokPace = paceOf(grokExpired ? null : grok.snapshot?.usedPercent ?? null, grok.snapshot?.resetsAt ?? null, grok.snapshot?.period === 'daily' ? 86400000 : grok.snapshot?.period === 'monthly' ? 30 * 86400000 : WEEK_MS);
  meter('grok-meter', 'grok-fill', grokLeft, grokPace, 'grok-pace');
  const grokStatus = grokExpired ? 'Awaiting reset' : grok.snapshot && grok.stale ? 'Stale · ' + grokLabels[grok.status] : grok.status !== 'ready' ? grokLabels[grok.status] :
    grokLeft !== null ? periodNames[grok.snapshot?.period || 'unknown'].long + ' remaining' : 'Percentage not reported';
  element('grok-meta').textContent = grokExpired ? 'Awaiting reset'
    : grok.snapshot && grok.stale ? 'Stale'
    : grok.status !== 'ready' ? grokLabels[grok.status]
    : grokLeft === null ? 'Percentage not reported'
    : grok.snapshot?.resetsAt ? countdown(grok.snapshot.resetsAt).replace('Resets in ', '') : periodNames[grok.snapshot?.period || 'unknown'].short;
  const grokTitle = 'Grok: ' + (grokLeft === null ? grokStatus : percent(grokLeft) + ' left') + (grokLeft !== null ? paceTag(grokPace) : '') + '. Open details.';
  element('grok-card').title = grokTitle;
  element('grok-card').setAttribute('aria-label', grokTitle);
  renderAntigravity(state.antigravity);
  renderStorage(state.storage);
  element('age').textContent = 'Codex · ' + ageLabel(state.ageMs).replace('Read ', '').replace('Awaiting first read', 'waiting');
  const refresh = element<HTMLButtonElement>('refresh');
  refresh.disabled = state.refreshing || state.claude.refreshing || state.grok.refreshing || state.antigravity.refreshing || state.cooldownMs > 0;
  refresh.title = state.cooldownMs > 0 ? 'Refresh available in ' + Math.ceil(state.cooldownMs / 1000) + ' seconds' : 'Refresh usage';
  // Grok needs the user's grokcli folder; without one its tile is hidden.
  element('grok-card').hidden = !state.config.grokcliRoot;
  renderSettings(state);
  if (state.config.firstRun && !firstRunShown) { firstRunShown = true; openPanel('settings'); action(() => window.limiter.firstRunSeen()); }
  if (panel) renderDetails();
  document.body.dataset.ready = 'true';
}
function renderDetails(): void {
  if (!current || !panel) return;
  const state = current;
  const content = element('details-content'); content.replaceChildren();
  const text = (value: string, heading = false) => { const line = document.createElement(heading ? 'h2' : 'p'); line.textContent = value; content.append(line); };
  element('details-title').textContent = { codex:'Codex limits', claude:'Claude Code limits', grok:'Grok subscription', antigravity:'Antigravity plan quota', storage:'Free disk space', settings:'Settings' }[panel];
  element('settings').hidden = panel !== 'settings';
  // Static form outside the re-rendered content, so typing survives the once-a-second state push.
  element('claude-calibrate').hidden = panel !== 'claude';
  if (panel === 'codex') {
    projectLines(state.projects.codex, text);
    text(labels[state.status] + ' · ' + ageLabel(state.ageMs) + (state.stale ? ' · stale sample' : ''));
    if (state.status === 'signed-out') text('Sign in through Codex, then refresh.');
    if (state.snapshot && !state.snapshot.scopeConfirmed) text('Account scope is unconfirmed.');
    for (const window of state.snapshot?.windows || []) {
      text(window.bucketName + ' · ' + windowLabel(window.durationMins) + ' · ' + window.slot, true);
      const expired = window.resetsAt !== null && window.resetsAt * 1000 <= Date.now();
      text(expired ? 'Reset passed, awaiting new data.' : window.remainingPercent === null ? 'Remaining capacity unavailable' : percent(window.remainingPercent) + ' remaining');
      text(reset(window.resetsAt));
      if (window.restricted) text('The account reports an additional restriction.');
    }
    if (!state.snapshot?.windows.length) text('No account quota is available yet.');
    const codexSelected = state.snapshot?.windows.find(window => window.key === state.snapshot?.selectedKey);
    const codexPace = paceOf(codexSelected?.usedPercent ?? null, codexSelected?.resetsAt ?? null, (codexSelected?.durationMins ?? 10080) * 60000);
    if (codexPace) text(codexPace.elapsedPercent + '% of the window has passed: ' + codexPace.label + '.');
    const codexForecast = forecastText(state.forecast.codex); if (codexForecast) text(codexForecast);
  } else if (panel === 'claude') {
    const claude = state.claude;
    const mark = claude.mode === 'estimate' ? '≈' : '';
    projectLines(state.projects.claude, text);
    text(claude.mode === 'exact' ? 'Exact reading from Claude Code' + (claude.exact?.host ? ' on ' + claude.exact.host : '') + (claude.exact?.source === 'mod' ? ' through the Limiter mod. ' : ' through the status line. ') + ageLabel(claude.ageMs).replace('Read', 'Received') + '.' :
      claude.mode === 'estimate' ? 'Estimate from Claude Code activity on this PC, scaled to your last reading. Checked every 15 minutes. ' + ageLabel(claude.ageMs) + '.' :
      claude.mode === 'uncalibrated' ? 'Enter the numbers from the Claude app usage card once; Limiter then estimates from Claude Code activity on this PC.' :
      claude.mode === 'scanning' ? 'Reading Claude Code activity on this PC.' : 'No Claude Code activity logs were found on this PC.');
    for (const [label, window] of [['Weekly', claude.weekly], ['Five-hour', claude.fiveHour]] as const) {
      text(label, true);
      text(window.percent === null ? 'No reading yet.' : mark + percent(remaining(window.percent)) + ' remaining · ' + (window.resetsAt === null ? 'Reset time unknown, enter it below' : reset(window.resetsAt)));
    }
    if (claude.anchor) text('Scaled to the ' + (claude.anchor.source === 'manual' ? 'reading you entered' : 'exact Claude Code reading') + ' at ' + reset(Math.floor(claude.anchor.at / 1000)) + '.');
    for (const [label, window, length, key] of [['Weekly', claude.weekly, WEEK_MS, 'claude-week'], ['Five-hour', claude.fiveHour, FIVE_HOUR_MS, 'claude-5h']] as const) {
      const pace = paceOf(window.percent, window.resetsAt, length);
      const forecast = forecastText(state.forecast[key]);
      if (pace) text(label + ': ' + pace.elapsedPercent + '% of the window has passed, ' + pace.label + '.' + (forecast ? ' ' + forecast : ''));
    }
    if (claude.mode !== 'exact') text('Counts ' + claude.coverage.replies.toLocaleString('en-US') + ' Claude Code replies from the last 8 days. Claude chat and other computers are not counted, so re-enter a reading if it drifts.');
  } else if (panel === 'grok') {
    const grok = state.grok;
    const snap = grok.snapshot;
    text('Read from your Grok subscription through grokcli every 15 minutes. ' + grokLabels[grok.status] + (snap ? ' · ' + ageLabel(Date.now() - snap.observedAt) + (grok.stale ? ' · stale' : '') : '') + '.');
    if (snap) {
      text(periodNames[snap.period].long + ' allowance', true);
      text(snap.remainingPercent === null ? 'Remaining percentage not reported.' : percent(snap.remainingPercent) + ' remaining');
      text(reset(snap.resetsAt));
      const grokPace = paceOf(snap.usedPercent, snap.resetsAt, snap.period === 'daily' ? 86400000 : snap.period === 'monthly' ? 30 * 86400000 : WEEK_MS);
      if (grokPace) text(grokPace.elapsedPercent + '% of the window has passed: ' + grokPace.label + '.');
      const grokForecast = forecastText(state.forecast.grok); if (grokForecast) text(grokForecast);
    }
    if (grok.status === 'signed-out') text('Sign in again: in your grokcli folder run python -m grokcli login, then refresh.');
    if (grok.status === 'setup') text('Needs Python on the PATH and your grokcli folder, chosen in Settings.');
    text('Reads your subscription allowance through grokcli.');
  } else if (panel === 'antigravity') {
    const agy = state.antigravity;
    const snap = agy.snapshot;
    text('Read from the Antigravity app on this PC every 5 minutes while it is open. ' + antigravityLabels[agy.status] + (snap ? ' · ' + ageLabel(Date.now() - snap.observedAt) + (agy.stale ? ' · stale' : '') : '') + '.');
    for (const pool of snap?.pools || []) {
      text(pool.name, true);
      for (const [title, bucket] of [['Weekly, outer ring', pool.weekly], ['5-hour, inner ring', pool.fiveHour]] as const) {
        text(title + ': ' + (!bucket ? 'not reported.' : bucketPassed(bucket) ? 'reset passed, awaiting new data.' :
          bucket.remainingPercent === null ? 'remaining percentage not reported.' : percent(bucket.remainingPercent) + ' remaining'));
        if (bucket && !bucketPassed(bucket)) text(reset(bucket.resetsAt));
      }
      if (pool.models.length) text(pool.models.join(', '));
    }
    if (snap && !snap.pools.length) text('Antigravity reported no model quota.');
    if (agy.status === 'closed') text('Open Antigravity to refresh. Limiter can read the quota only while the app runs.');
    if (agy.status === 'signed-out') text('Sign in to Antigravity, then refresh.');
    if (agy.status === 'compatibility') text('Antigravity changed how it reports quota, so Limiter needs an update.');
    text('Models in one group share a weekly limit and a 5-hour limit. The outer ring shows the weekly limit and the inner ring the 5-hour limit.');
  } else if (panel === 'storage') {
    for (const id of diskIds) {
      const { status, reading, label, volume } = state.storage[id];
      if (status === 'off') continue;
      text(label + ' · ' + volume, true);
      if (reading) {
        text(formatDiskBytes(reading.freeBytes) + ' free of ' + formatDiskBytes(reading.totalBytes) + ' (' + percent(100 * reading.freeBytes / reading.totalBytes) + ' free).');
        text((status === 'stale' ? 'Last known reading. ' : '') + ageLabel(Date.now() - reading.observedAt) + '.');
      } else text(status === 'waiting' ? 'Waiting for a disk reading.' : 'Disk unavailable. Select Refresh to try again.');
    }
    text('Checks every five minutes while this PC is active. Select Refresh to check now.');
  } else {
    if (state.settingsNotice) text(state.settingsNotice);
    if (!state.desktopAttached) text('Waiting for the Windows desktop surface.');
  }
}
function openPanel(value: typeof panel): void {
  panel = value; element('details').hidden = value === null;
  // A panel always opens at its top, where the project list now sits.
  element('details').scrollTop = 0;
  element('settings-toggle').setAttribute('aria-expanded', String(value !== null));
  renderDetails();
}
// A field that differs from its last rendered setting is a draft, even after focus moves elsewhere.
function renderSettings(state: DisplayState): void {
  const config = state.config;
  element('projects-root').textContent = config.projectsRoot || 'not set';
  element('grokcli-root').textContent = config.grokcliRoot || 'not set, Grok row hidden';
  const fill = (id: string, value: string) => {
    const input = element<HTMLInputElement>(id);
    if (input.value === input.defaultValue) input.value = value;
    input.defaultValue = value;
  };
  fill('local-disk-label', config.localDiskLabel || '');
  element<HTMLInputElement>('local-disk-label').placeholder = config.pcName;
  fill('remote-disk-label', config.remoteDisk?.label || '');
  fill('remote-disk-host', config.remoteDisk?.host || '');
  element<HTMLInputElement>('start-with-windows').checked = config.startWithWindows;
  element('startup-note').hidden = !config.startupShortcut;
}
function settingsAction(run: () => Promise<void>, done: string): void {
  const status = element('settings-status');
  status.textContent = 'Saving';
  void run().then(() => { status.textContent = done; }).catch((error: unknown) => {
    // Electron prefixes errors from main; show only the validation message.
    status.textContent = (error instanceof Error ? error.message : 'Not saved').replace(/^.*Error: /, '');
  });
}
let firstRunShown = false;
function action(run: () => Promise<void>): void {
  void run().catch(() => { element('message').hidden = false; element('message').textContent = 'Action unavailable. Try again from the tray.'; });
}
element('refresh').addEventListener('click', () => action(() => window.limiter.refresh()));
element('hide').addEventListener('click', () => action(() => window.limiter.hide()));
element('quit').addEventListener('click', () => action(() => window.limiter.quit()));
element<HTMLSelectElement>('theme').addEventListener('change', event => action(() => window.limiter.theme((event.target as HTMLSelectElement).value as Theme)));
element('choose-source').addEventListener('click', () => action(() => window.limiter.chooseSource()));
element('choose-projects').addEventListener('click', () => settingsAction(() => window.limiter.chooseFolder('projects'), 'Projects folder saved.'));
element('clear-projects').addEventListener('click', () => settingsAction(() => window.limiter.updateSettings({ projectsRoot: null }), 'Projects folder cleared.'));
element('choose-grokcli').addEventListener('click', () => settingsAction(() => window.limiter.chooseFolder('grokcli'), 'grokcli folder saved.'));
element('clear-grokcli').addEventListener('click', () => settingsAction(() => window.limiter.updateSettings({ grokcliRoot: null }), 'grokcli folder cleared; Grok row hidden.'));
element('save-disks').addEventListener('click', () => {
  const value = (id: string) => element<HTMLInputElement>(id).value.trim();
  const host = value('remote-disk-host');
  settingsAction(() => window.limiter.updateSettings({ localDiskLabel: value('local-disk-label') || null,
    ...(host ? { remoteDisk: { host, label: value('remote-disk-label') || host } } : {}) }), 'Disk names saved.');
});
element('clear-remote').addEventListener('click', () => settingsAction(async () => {
  await window.limiter.updateSettings({ remoteDisk: null });
  for (const id of ['remote-disk-label', 'remote-disk-host']) {
    const input = element<HTMLInputElement>(id); input.value = ''; input.defaultValue = '';
  }
}, 'Remote disk removed.'));
element<HTMLInputElement>('start-with-windows').addEventListener('change', event =>
  settingsAction(() => window.limiter.updateSettings({ startWithWindows: (event.target as HTMLInputElement).checked }), 'Start-up choice saved.'));
element('claude-save').addEventListener('click', () => {
  const field = (id: string) => element<HTMLInputElement>(id).value;
  const status = element('claude-form-status');
  status.textContent = 'Saving';
  void window.limiter.calibrateClaude({ weeklyPercent: field('claude-weekly'), weeklyResetsIn: field('claude-weekly-resets'),
    fiveHourPercent: field('claude-five'), fiveHourResetsIn: field('claude-five-resets') })
    .then(() => { status.textContent = 'Saved. Estimates now scale to this reading.'; for (const id of ['claude-weekly', 'claude-weekly-resets', 'claude-five', 'claude-five-resets']) element<HTMLInputElement>(id).value = ''; })
    .catch(() => { status.textContent = 'Not saved. Use numbers like 80 and 12h 32m, as the usage card shows them.'; });
});
element('settings-toggle').addEventListener('click', () => openPanel(panel ? null : 'settings'));
element('close-details').addEventListener('click', () => openPanel(null));
for (const section of ['codex','claude','grok'] as const) element(section + '-card').addEventListener('click', () => openPanel(section));
for (const id of diskIds) element(id + '-card').addEventListener('click', () => openPanel('storage'));
document.addEventListener('keydown', event => { if (event.key === 'Escape') openPanel(null); });
window.limiter.subscribe(render);
void window.limiter.state().then(render).catch(() => {
  element('message').hidden = false; element('message').textContent = 'Desktop connection unavailable. Restart Limiter.';
});
