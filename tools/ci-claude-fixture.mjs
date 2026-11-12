// Writes a small Claude Code log for the CI smoke test into the folder that CLAUDE_CONFIG_DIR names, because a CI
// runner has never run Claude Code. It refuses to run without that variable, so it never touches a real Claude folder.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = process.env.CLAUDE_CONFIG_DIR;
if (!root || !path.isAbsolute(root)) throw new Error('Set CLAUDE_CONFIG_DIR to an absolute fixture folder first.');
if (/[\\/]\.claude[\\/]?$/i.test(root)) throw new Error('Refusing to write into a real .claude folder.');
const folder = path.join(root, 'projects', 'limiter-ci');
await fs.mkdir(folder, { recursive: true });
const now = Date.now();
// Three replies in the last few hours, in the shape Claude Code writes, under one project folder.
const lines = [1, 2, 3].map(index => JSON.stringify({
  type: 'assistant', timestamp: new Date(now - index * 3600000).toISOString(), cwd: 'C:\\Projects\\Fixture', requestId: 'req_ci_' + index, uuid: 'ci-' + index,
  message: { id: 'msg_ci_' + index, model: 'claude-sonnet-5', usage: { input_tokens: 1200, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 } }
}));
await fs.writeFile(path.join(folder, 'fixture.jsonl'), lines.join('\n') + '\n');
console.log('Wrote ' + lines.length + ' Claude Code replies to ' + folder);
