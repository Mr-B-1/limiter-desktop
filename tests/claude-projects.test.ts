import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeLogScanner, parseLogLine, rawTokens } from '../src/providers/claude-local.js';
import { OUTSIDE_LABEL, WORKSPACE_ROOT_LABEL, defaultRoots, projectLabel } from '../src/shared/projects.js';
import type { ProjectInputFile } from '../src/services/project-input.js';

const hour = 3600000;
const roots = defaultRoots('C:\\Users\\user', 'C:\\Projects');
// Synthetic reply lines: only the fields the scanner reads, never a real transcript.
function reply(id: string, at: number, cwd: string | undefined, usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 1000 }, model = 'claude-opus-5-5'): string {
  return JSON.stringify({ type: 'assistant', requestId: 'req-' + id, timestamp: new Date(at).toISOString(), ...(cwd === undefined ? {} : { cwd }), sessionId: 'session-' + id,
    message: { id: 'msg-' + id, model, content: [{ type: 'text', text: 'x' }], usage } });
}
async function withLogs(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limiter-claude-projects-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('a parsed reply carries its working folder and raw token count; labels follow the projects folder', () => {
  const parsed = parseLogLine(reply('a', Date.UTC(2026, 9, 20, 12), 'C:\\Projects\\Beta\\wiki', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 5 } }));
  assert.equal(parsed?.event.cwd, 'C:\\Projects\\Beta\\wiki');
  assert.equal(projectLabel(parsed?.event.cwd, roots), 'Beta');
  assert.equal(parsed?.event.tokens, 375);
  assert.equal(projectLabel(parseLogLine(reply('b', Date.UTC(2026, 9, 20, 12), 'C:\\Projects'))?.event.cwd, roots), WORKSPACE_ROOT_LABEL);
  assert.equal(parseLogLine(reply('c', Date.UTC(2026, 9, 20, 12), undefined))?.event.cwd, '');
  assert.equal(projectLabel('', roots), OUTSIDE_LABEL);
  assert.equal(rawTokens({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }), 10);
});

test('a fresh audit binds the incomplete tail and normal refresh finishes it exactly once', async () => withLogs(async root => {
  const now = Date.now();
  const file = path.join(root, 'session.jsonl');
  const complete = reply('one', now - 1000, 'C:\\Projects\\One') + '\n';
  const second = reply('two', now - 500, 'C:\\Projects\\Two');
  const prefix = complete + second.slice(0, 40);
  await fs.writeFile(file, prefix);
  const scanner = new ClaudeLogScanner(root);
  const files: ProjectInputFile[] = [];
  await scanner.scan(now, files);
  assert.equal(scanner.replies, 1);
  assert.equal(files.length, 1);
  assert.equal(files[0].byteLimit, Buffer.byteLength(prefix));
  assert.equal(files[0].sha256, createHash('sha256').update(prefix).digest('hex'));
  await fs.appendFile(file, second.slice(40) + '\n');
  await scanner.scan(now);
  assert.deepEqual(scanner.byProject(now - hour, now, roots).map(row => [row.name, row.tokens]), [['One', 2000], ['Two', 2000]]);
  await assert.rejects(scanner.scan(now, []), /fresh log scan/);
}));

test('byProject splits the window per project, keeps the first line\'s folder and the largest line\'s tokens, and regroups when the projects folder changes', async () => withLogs(async root => {
  const now = Date.UTC(2026, 9, 20, 15);
  const file = path.join(root, 'C--Projects-Beta', 'session.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const partial = reply('1', now - hour, 'C:\\Projects\\Beta', { input_tokens: 1000, output_tokens: 4 });
  const final = reply('1', now - hour + 2000, 'C:\\Projects\\Other', { input_tokens: 1000, output_tokens: 1000 });
  await fs.writeFile(file, [partial, final, reply('2', now - 2 * hour, 'C:\\Projects\\Gamma\\src'), reply('3', now - 30 * 60000, 'C:\\Projects'), reply('old', now - 5 * hour, 'C:\\Projects\\Beta')].join('\n') + '\n');
  const scanner = new ClaudeLogScanner(root);
  await scanner.scan(now);
  const rows = scanner.byProject(now - 3 * hour, now, roots);
  assert.deepEqual(rows.map(row => row.name), ['Beta', 'Gamma', WORKSPACE_ROOT_LABEL]);
  // Reply 1 keeps the folder of its first line and the token count of its largest line.
  assert.equal(rows[0].tokens, 2000);
  assert.equal(Math.round(rows[0].units * 1e6), 24000);
  assert.equal(scanner.byProject(now - 3 * hour, now - 2 * hour, roots).length, 0);
  assert.equal(scanner.byProject(now - 3 * hour, now - 2 * hour + 1, roots)[0]?.name, 'Gamma');
  // Without a projects folder each session counts under its own folder name, with no rescan.
  assert.deepEqual(scanner.byProject(now - 3 * hour, now, defaultRoots('C:\\Users\\user')).map(row => row.name), ['Beta', 'Projects', 'src']);
}));
