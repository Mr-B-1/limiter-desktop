import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
// One hash over every file in the package, so a release can prove it ships exactly what this smoke ran.
async function treeHash(directory) {
  const lines = [];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name); else lines.push(name.split(path.sep).join('/') + ' ' + createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex'));
    }
  }
  await walk('');
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}
const local = process.env.LOCALAPPDATA;
if (!local) throw new Error('Host-local storage unavailable');
const root = path.join(local, 'Limiter-build');
// --arch picks which package to test; each run gets a brand-new profile and its own receipt.
const arch = process.argv.find(arg => arg.startsWith('--arch='))?.slice('--arch='.length) ?? (process.arch === 'x64' ? 'x64' : 'arm64');
if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported --arch ' + arch);
const pointer = await fs.readFile(path.join(root, 'release-path-' + arch + '.txt'), 'utf8').catch(error => {
  if (error.code === 'ENOENT' && arch === 'arm64') return fs.readFile(path.join(root, 'release-path.txt'), 'utf8');
  throw error;
});
const exe = pointer.trim();
const resolved = await fs.realpath(exe);
const releaseRoot = await fs.realpath(path.join(root, 'releases'));
if (!resolved.toLowerCase().startsWith(releaseRoot.toLowerCase() + path.sep)) throw new Error('Executable escaped the release directory');
const runDirectory = path.join(root, 'smoke', arch, new Date().toISOString().replace(/[:.]/g, '-'));
const profile = path.join(runDirectory, 'profile');
await fs.mkdir(profile, { recursive: true });
const receiptPath = path.join(runDirectory, 'receipt.json');
try { await fs.rename(receiptPath, receiptPath + '.previous'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const scale = process.argv.find(arg => arg.startsWith('--scale='))?.split('=')[1];
if (scale && !['1', '1.5'].includes(scale)) throw new Error('Unsupported smoke scale');
const started = Date.now();
const archive = path.join(path.dirname(exe), 'resources/app.asar');
const packageSha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
await new Promise((resolve, reject) => {
  const child = spawn(exe, ['--smoke-test', '--smoke-profile=' + profile, ...(scale ? ['--force-device-scale-factor=' + scale] : [])], { windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged smoke exceeded 90 seconds')); }, 90000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Packaged app exit ' + code)); });
});
const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
if (await fs.realpath(receipt.executable) !== resolved || packageSha256 !== createHash('sha256').update(await fs.readFile(archive)).digest('hex')) throw new Error('Package changed or receipt belongs to another executable');
if ((await fs.stat(receiptPath)).mtimeMs < started || receipt.result !== 'PASS' || !receipt.packaged || !receipt.childAbsent) throw new Error('Fresh complete packaged PASS receipt missing: ' + (receipt.reason || 'unknown'));
try { process.kill(receipt.childPid, 0); throw new Error('Independent check found owned child alive'); }
catch (error) { if (error.code !== 'ESRCH') throw error; }
receipt.packageSha256 = packageSha256;
receipt.packageTreeSha256 = await treeHash(path.dirname(exe));
if (receipt.arch !== arch) throw new Error('Receipt architecture ' + receipt.arch + ' does not match --arch ' + arch);
await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2));
// Latest receipt per architecture; receipt.json stays the ARM64 one that the private release steps read.
await fs.copyFile(receiptPath, path.join(root, 'smoke', 'receipt-' + arch + '.json'));
if (arch === 'arm64') await fs.copyFile(receiptPath, path.join(root, 'smoke', 'receipt.json'));
if (scale) await fs.copyFile(receiptPath, path.join(root, 'smoke', 'receipt-scale-' + scale + '.json'));
console.log(JSON.stringify({ arch, scope: receipt.scope, result: receipt.result, firstReadyMs: receipt.firstReadyMs, packaged: receipt.packaged, childAbsent: true, duplicateLaunches: receipt.duplicateLaunches, quotaReads: receipt.counts.quotaReads, receiptPath }, null, 2));
