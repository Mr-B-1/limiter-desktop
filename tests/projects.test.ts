import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_APP_LABEL, OUTSIDE_LABEL, WORKSPACE_ROOT_LABEL, defaultRoots, projectLabel } from '../src/shared/projects.js';
import { claudeWindow, codexWindow, rank } from '../src/services/projects.js';
import { WEEK_MS } from '../src/providers/claude-local.js';
import type { QuotaSnapshot } from '../src/shared/usage.js';

const roots = defaultRoots('C:\\Users\\user', 'C:\\Projects');
const hour = 3600000;

test('project labels follow the first workspace folder and the two outside rows', () => {
  assert.equal(projectLabel('C:\\Projects\\Beta\\wiki', roots), 'Beta');
  assert.equal(projectLabel('C:\\Projects\\Beta', roots), 'Beta');
  assert.equal(projectLabel('C:/Projects/Beta/sub/deeper', roots), 'Beta');
  assert.equal(projectLabel('c:\\PROJECTS\\beta', roots), 'beta');
  assert.equal(projectLabel('C:\\Projects', roots), WORKSPACE_ROOT_LABEL);
  assert.equal(projectLabel('C:\\Projects\\', roots), WORKSPACE_ROOT_LABEL);
  assert.equal(projectLabel('C:\\Projects\\Alpha\\src', roots), 'Alpha');
  assert.equal(projectLabel('C:\\Users\\user\\Documents\\Codex\\2026-01-01\\x', roots), CODEX_APP_LABEL);
  assert.equal(projectLabel('c:/users/user/documents/codex', roots), CODEX_APP_LABEL);
  assert.equal(projectLabel('C:\\ProjectsX\\D', roots), OUTSIDE_LABEL);
  assert.equal(projectLabel('D:\\other', roots), OUTSIDE_LABEL);
  assert.equal(projectLabel('/root/x', roots), OUTSIDE_LABEL);
  assert.equal(projectLabel(null, roots), OUTSIDE_LABEL);
  assert.equal(projectLabel('', roots), OUTSIDE_LABEL);
  assert.equal(projectLabel(42, roots), OUTSIDE_LABEL);
});

test('without a projects folder each session counts under its own folder name', () => {
  const loose = defaultRoots('C:\\Users\\user');
  assert.equal(projectLabel('D:\\code\\site\\', loose), 'site');
  assert.equal(projectLabel('/home/user/app', loose), 'app');
  assert.equal(projectLabel('C:\\Users\\user\\Documents\\Codex\\x', loose), CODEX_APP_LABEL);
  assert.equal(projectLabel(null, loose), OUTSIDE_LABEL);
});

test('default roots hang the Codex app folder off the home folder', () => {
  assert.deepEqual(defaultRoots('C:\\Users\\user\\'), { workspace: null, codexApp: 'C:\\Users\\user\\Documents\\Codex' });
});

function snapshot(windows: Partial<QuotaSnapshot['windows'][number]>[], selectedKey: string | null): QuotaSnapshot {
  return { schemaVersion: 1, provider: 'codex', generation: 1, selectedKey, selection: selectedKey ? 'single' : 'absent', fetchedAt: 0, plan: 'pro', scopeConfirmed: true,
    windows: windows.map(window => ({ key: 'k', bucketId: 'b', bucketName: 'codex', slot: 'primary', durationMins: 10080, usedPercent: 10, remainingPercent: 90, resetsAt: null, restricted: false, ...window })) };
}

test('windows are milliseconds, half-open, and roll forward once a reset passes', () => {
  const reset = Date.UTC(2026, 9, 24, 3);
  assert.deepEqual(claudeWindow(reset - hour, reset / 1000), { start: reset - WEEK_MS, end: reset });
  assert.deepEqual(claudeWindow(reset + hour, reset / 1000), { start: reset, end: reset + WEEK_MS });
  assert.deepEqual(claudeWindow(reset, null), { start: reset - WEEK_MS, end: null });
  const fiveHours = 5 * hour;
  assert.deepEqual(codexWindow(reset - hour, snapshot([{ key: 'k', resetsAt: reset / 1000, durationMins: 300 }], 'k')), { start: reset - fiveHours, end: reset });
  assert.deepEqual(codexWindow(reset, snapshot([{ key: 'k', resetsAt: reset / 1000, durationMins: 300 }], 'k')), { start: reset, end: reset + fiveHours });
  assert.deepEqual(codexWindow(reset + 11 * hour, snapshot([{ key: 'k', resetsAt: reset / 1000, durationMins: 300 }], 'k')), { start: reset + 2 * fiveHours, end: reset + 3 * fiveHours });
  // No selection, no reset or no duration falls back to a rolling week.
  assert.deepEqual(codexWindow(reset, snapshot([{ key: 'k', resetsAt: reset / 1000 }], null)), { start: reset - WEEK_MS, end: null });
  assert.deepEqual(codexWindow(reset, snapshot([{ key: 'k', resetsAt: null }], 'k')), { start: reset - WEEK_MS, end: null });
  assert.deepEqual(codexWindow(reset, snapshot([{ key: 'k', resetsAt: reset / 1000, durationMins: null }], 'k')), { start: reset - WEEK_MS, end: null });
  assert.deepEqual(codexWindow(reset, null), { start: reset - WEEK_MS, end: null });
});

test('ranking keeps the top five by weighted share, ties by name, with the outside rows counted and coverage status', () => {
  const window = { start: 0, end: 1000 };
  const totals = [{ name: 'Beta', units: 30, tokens: 300 }, { name: OUTSIDE_LABEL, units: 30, tokens: 100 }, { name: 'Gamma', units: 20, tokens: 50 },
    { name: CODEX_APP_LABEL, units: 10, tokens: 10 }, { name: 'Delta', units: 5, tokens: 5 }, { name: 'Epsilon', units: 4, tokens: 4 }, { name: 'Zed', units: 1, tokens: 1 }];
  const view = rank(totals, window, { files: 3, read: 3, skipped: 0, unreadable: 0, withoutTokens: 1, malformedLines: 0, sessions: 3 });
  assert.deepEqual(view.rows.map(row => [row.name, row.share, row.tokens]), [['Beta', 30, 300], [OUTSIDE_LABEL, 30, 100], ['Gamma', 20, 50], [CODEX_APP_LABEL, 10, 10], ['Delta', 5, 5]]);
  assert.equal(view.totalUnits, 100); assert.equal(view.totalTokens, 470); assert.equal(view.status, 'ok'); assert.deepEqual(view.window, window);
  assert.deepEqual(rank([], window, null), { rows: [], window, coverage: null, status: 'ok', totalUnits: 0, totalTokens: 0 });
  assert.equal(rank([{ name: 'A', units: 1, tokens: 3 }, { name: 'B', units: 2, tokens: 3 }], window, null).rows[0].share, 66.7);
  assert.equal(rank([{ name: 'A', units: 0, tokens: 3 }], window, null).rows[0].share, 0);
  assert.equal(rank(totals, window, { files: 3, read: 2, skipped: 1, unreadable: 0, withoutTokens: 0, malformedLines: 0, sessions: 2 }).status, 'degraded');
  assert.equal(rank(totals, window, { files: 3, read: 3, skipped: 0, unreadable: 0, withoutTokens: 0, malformedLines: 2, sessions: 3 }).status, 'degraded');
});
