// Zips one smoke-tested package with README.txt, proves the zip holds exactly the tested files, and records SHA-256 sums.
// Usage: node tools/make-release.mjs --arch=arm64
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = process.env.LOCALAPPDATA;
if (!local) throw new Error('LOCALAPPDATA is required for host-local builds.');
const buildRoot = path.join(local, 'Limiter-build');
const arch = process.argv.find(arg => arg.startsWith('--arch='))?.slice('--arch='.length) ?? (process.arch === 'x64' ? 'x64' : 'arm64');
if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported --arch ' + arch);
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
const sha = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function treeHash(directory) {
  const lines = [];
  for (const file of await files(directory)) lines.push(file + ' ' + await sha(path.join(directory, file)));
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}
const run = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(tar, args, { cwd, windowsHide: true, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('tar exited ' + code)));
});
async function files(directory, relative = '') {
  const list = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release must not contain links');
    if (entry.isDirectory()) list.push(...await files(directory, name)); else list.push(name.split(path.sep).join('/'));
  }
  return list.sort();
}

// Only a package whose smoke receipt passed, for this version and architecture, with the same archive hash, is released.
const exe = (await fs.readFile(path.join(buildRoot, 'release-path-' + arch + '.txt'), 'utf8')).trim();
const packageDir = path.dirname(exe);
const receipt = JSON.parse(await fs.readFile(path.join(buildRoot, 'smoke', 'receipt-' + arch + '.json'), 'utf8'));
const archiveSha = await sha(path.join(packageDir, 'resources', 'app.asar'));
if (receipt.result !== 'PASS' || receipt.version !== version || receipt.arch !== arch || receipt.packageSha256 !== archiveSha || receipt.packageTreeSha256 !== await treeHash(packageDir))
  throw new Error('No passing smoke receipt matches this ' + arch + ' package and version ' + version);
// A public release needs every desktop check proven, so a run on a locked or idle screen does not qualify.
const unproven = [...(receipt.unverifiedWhileLocked || []), ...(receipt.unverifiedWhilePaused || [])];
if (unproven.length) throw new Error('Smoke left checks unverified (' + unproven.join('; ') + '); rerun it on an unlocked, active screen');
const name = 'Limiter-' + version + '-windows-' + arch;
const staging = path.join(buildRoot, 'release-staging', name);
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(path.dirname(staging), { recursive: true });
await fs.cp(packageDir, staging, { recursive: true });
await fs.copyFile(path.join(root, 'README.txt'), path.join(staging, 'README.txt'));
const dist = path.join(buildRoot, 'dist');
await fs.mkdir(dist, { recursive: true });
const zip = path.join(dist, name + '.zip');
try { await fs.rename(zip, zip + '.previous-' + Date.now()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await run(['-a', '-c', '-f', zip, '-C', path.dirname(staging), name], path.dirname(staging));
// Extract into a new folder and compare every file with the staged, tested package.
const check = path.join(buildRoot, 'release-verify', name + '-' + Date.now());
await fs.mkdir(check, { recursive: true });
await run(['-x', '-f', zip, '-C', check], check);
const expected = await files(staging);
const extracted = await files(path.join(check, name));
if (JSON.stringify(expected) !== JSON.stringify(extracted)) throw new Error('Zip file list differs from the tested package');
for (const file of expected) if (await sha(path.join(staging, file)) !== await sha(path.join(check, name, file))) throw new Error('Zip content differs: ' + file);
const sums = [];
for (const file of (await fs.readdir(dist)).filter(item => item.endsWith('.zip')).sort()) sums.push(await sha(path.join(dist, file)) + '  ' + file);
await fs.writeFile(path.join(dist, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(JSON.stringify({ result: 'PASS', zip, files: expected.length, zipSha256: await sha(zip), packageSha256: archiveSha }, null, 2));
