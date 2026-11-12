// Points Claude Code at the limiter-usage mod for every new session, desktop app included, through the one
// settings key that does it: CLAUDE_CODE_PLUGIN_DIRS in the env block of ~/.claude/settings.json.
// Scope discipline matches the status-line install: one key changes, every other byte is proven untouched.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const action = process.argv[2] || 'install';
// Paths come from this checkout, wherever it was cloned or unzipped.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modDir = path.join(repoRoot, 'mods', 'limiter-usage');
const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const rollbackDir = path.join(os.homedir(), '.local', 'share', 'Limiter', 'bridge');
const rollbackFile = path.join(rollbackDir, 'plugin-dirs-before.json');
// The receipt stays beside the rollback copy in the user's own Limiter folder, never in the checkout.
const receiptFile = path.join(rollbackDir, 'mod-install-receipt.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toString();

await fs.access(path.join(modDir, '.claude-plugin', 'plugin.json'));
const beforeBytes = await fs.readFile(settingsFile);
const before = JSON.parse(beforeBytes.toString('utf8').replace(/^\uFEFF/, ''));
const env = { ...(before.env || {}) };
const prior = typeof env.CLAUDE_CODE_PLUGIN_DIRS === 'string' ? env.CLAUDE_CODE_PLUGIN_DIRS : null;
const entries = prior ? prior.split(path.delimiter).filter(Boolean) : [];
if (action === 'install') { if (!entries.some(entry => path.resolve(entry).toLowerCase() === modDir.toLowerCase())) entries.push(modDir); }
else if (action === 'remove') { for (let i = entries.length - 1; i >= 0; i--) if (path.resolve(entries[i]).toLowerCase() === modDir.toLowerCase()) entries.splice(i, 1); }
else throw new Error('Unknown action');
if (entries.length) env.CLAUDE_CODE_PLUGIN_DIRS = entries.join(path.delimiter); else delete env.CLAUDE_CODE_PLUGIN_DIRS;
const others = structuredClone(before); delete others.env;
const untouched = digest(JSON.stringify(others));
const otherEnv = { ...(before.env || {}) }; delete otherEnv.CLAUDE_CODE_PLUGIN_DIRS;
await fs.mkdir(rollbackDir, { recursive: true });
await fs.writeFile(rollbackFile, JSON.stringify({ CLAUDE_CODE_PLUGIN_DIRS: prior }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
const after = { ...before, env };
if (!(await fs.readFile(settingsFile)).equals(beforeBytes)) throw new Error('Claude settings changed during installation; nothing replaced');
const temporary = settingsFile + '.limiter.tmp';
await fs.writeFile(temporary, JSON.stringify(after, null, 2) + '\n', { mode: 0o600 });
await fs.rename(temporary, settingsFile);
const verified = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
const verifiedEnv = { ...(verified.env || {}) }; const installed = verifiedEnv.CLAUDE_CODE_PLUGIN_DIRS ?? null; delete verifiedEnv.CLAUDE_CODE_PLUGIN_DIRS;
delete verified.env;
if (digest(JSON.stringify(verified)) !== untouched || JSON.stringify(verifiedEnv) !== JSON.stringify(otherEnv)) throw new Error('Settings preservation check failed');
const receipt = { result: 'PASS', action, scope: 'Claude user settings env.CLAUDE_CODE_PLUGIN_DIRS only; every other setting, the statusLine and hooks retained', verifiedAt: stamp(),
  settingsFile, modDir, priorValuePresent: prior !== null, installedValue: installed, otherSettingsSha256: untouched, rollbackFile, credentialsRead: false, hooksChanged: false, modelRequests: 0 };
await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
