import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = process.env.LOCALAPPDATA;
if (!local) throw new Error('LOCALAPPDATA is required for host-local builds.');
const buildRoot = path.join(local, 'Limiter-build');
const work = path.join(buildRoot, 'work');
const appDir = path.join(buildRoot, 'app');
const command = process.argv[2] || 'build';
// --arch=x64 or --arch=arm64 picks the Windows target; the default is the PC's own type, so ARM64 on an ARM64 PC as before.
// The PC's own type: PROCESSOR_IDENTIFIER is system-wide, so x64 Node under emulation on an ARM64 PC still targets ARM64.
function defaultArch() { return /^ARM/i.test(process.env.PROCESSOR_IDENTIFIER || '') ? 'arm64' : process.arch === 'x64' ? 'x64' : 'arm64'; }
const archFlag = process.argv.find(arg => arg.startsWith('--arch='))?.slice('--arch='.length) ?? defaultArch();
if (!['x64', 'arm64'].includes(archFlag)) throw new Error('Unsupported --arch ' + archFlag + '; use x64 or arm64.');
const arch = archFlag;
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.mkdir(buildRoot, { recursive: true });

async function run(exe, args, cwd = work, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, stdio: 'inherit', windowsHide: true, env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(path.basename(exe) + ' exited ' + code)));
  });
}
async function moduleFrom(name) {
  return import(pathToFileURL(path.join(buildRoot, 'node_modules', name)).href);
}
async function setup() {
  const toolsManifest = { name: 'limiter-local-build', version: manifest.version, private: true, type: 'module', dependencies: manifest.dependencies, devDependencies: manifest.devDependencies };
  await fs.writeFile(path.join(buildRoot, 'package.json'), JSON.stringify(toolsManifest, null, 2));
  const lock = path.join(root, 'package-lock.json');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  try {
    await fs.copyFile(lock, path.join(buildRoot, 'package-lock.json'));
    const locked = JSON.parse(await fs.readFile(lock, 'utf8')).packages[''];
    const unchanged = JSON.stringify(locked.dependencies || {}) === JSON.stringify(manifest.dependencies || {}) && JSON.stringify(locked.devDependencies) === JSON.stringify(manifest.devDependencies);
    await run(process.execPath, [npmCli, unchanged ? 'ci' : 'install', '--no-fund', '--no-audit'], buildRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await run(process.execPath, [npmCli, 'install', '--no-fund', '--no-audit'], buildRoot);
    await fs.copyFile(path.join(buildRoot, 'package-lock.json'), lock);
  }
  await fs.copyFile(path.join(buildRoot, 'package-lock.json'), lock);
}
async function stage() {
  await fs.mkdir(work, { recursive: true });
  for (const name of ['src', 'tests', 'assets']) await fs.rm(path.join(work, name), { recursive: true, force: true });
  for (const name of ['src', 'tests', 'assets', 'tsconfig.json', 'eslint.config.mjs', 'package.json']) {
    try { await fs.cp(path.join(root, name), path.join(work, name), { recursive: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
// koffi ships its native module per platform at the same version; fetch the matching one with npm pack so the installed tree is untouched.
async function koffiFor(target) {
  const folder = path.join(buildRoot, 'node_modules', '@koromix', 'koffi-win32-' + target);
  try { await fs.access(path.join(folder, 'package.json')); return folder; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const version = JSON.parse(await fs.readFile(path.join(buildRoot, 'node_modules', 'koffi', 'package.json'), 'utf8')).version;
  const download = path.join(buildRoot, 'koffi-' + target + '-' + version);
  await fs.mkdir(download, { recursive: true });
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await run(process.execPath, [npmCli, 'pack', '@koromix/koffi-win32-' + target + '@' + version, '--pack-destination', download, '--silent'], download);
  const archive = (await fs.readdir(download)).find(name => name.endsWith('.tgz'));
  if (!archive) throw new Error('npm pack produced no koffi archive for ' + target);
  await run(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe'), ['-xzf', archive], download);
  await fs.cp(path.join(download, 'package'), folder, { recursive: true, errorOnExist: true, force: false });
  return folder;
}
async function compile(spike = false) {
  await stage();
  const esbuild = await moduleFrom('esbuild/lib/main.js');
  await fs.mkdir(appDir, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(work, spike ? 'src/spike.ts' : 'src/main.ts')], outfile: path.join(appDir, 'main.cjs'), platform: 'node', format: 'cjs', target: 'node24', bundle: true, external: ['electron', 'koffi'], sourcemap: false });
  if (!spike) {
    await esbuild.build({ entryPoints: [path.join(work, 'src/bridge/claude-statusline.ts')], outfile: path.join(appDir, 'claude-statusline.cjs'), platform: 'node', format: 'cjs', target: 'node24', bundle: true });
    await esbuild.build({ entryPoints: [path.join(work, 'src/preload.ts')], outfile: path.join(appDir, 'preload.cjs'), platform: 'node', format: 'cjs', target: 'node24', bundle: true, external: ['electron'] });
    await esbuild.build({ entryPoints: [path.join(work, 'src/renderer/widget.ts')], outfile: path.join(appDir, 'widget.js'), platform: 'browser', format: 'iife', target: 'chrome148', bundle: true });
    for (const file of ['index.html', 'styles.css']) await fs.copyFile(path.join(work, 'src/renderer', file), path.join(appDir, file));
    await fs.cp(path.join(work, 'assets'), path.join(appDir, 'assets'), { recursive: true });
  }
  await fs.cp(path.join(buildRoot, 'node_modules/koffi'), path.join(appDir, 'node_modules/koffi'), { recursive: true });
  await fs.rm(path.join(appDir, 'node_modules', '@koromix'), { recursive: true, force: true });
  await fs.cp(await koffiFor(arch), path.join(appDir, 'node_modules', '@koromix', 'koffi-win32-' + arch), { recursive: true });
  await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'limiter', productName: 'Limiter', version: manifest.version, main: 'main.cjs', private: true, dependencies: manifest.dependencies }));
}
async function pack(spike = false) {
  await compile(spike);
  const { packager } = await moduleFrom('@electron/packager/dist/index.js');
  const source = await fs.readFile(path.join(appDir, 'main.cjs'));
  const id = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const out = path.join(buildRoot, spike ? 'spikes' : 'releases', Date.now().toString(36) + '-' + id + '-' + arch);
  const destinations = await packager({ dir: appDir, out, name: spike ? 'LimiterSourceProbe' : 'Limiter', platform: 'win32', arch, electronVersion: manifest.devDependencies.electron, asar: { unpack: '**/*.node' }, overwrite: false, prune: false, ...(spike ? {} : { icon: path.join(work, 'assets/tray.ico') }) });
  const exe = path.join(destinations[0], (spike ? 'LimiterSourceProbe' : 'Limiter') + '.exe');
  // One pointer per architecture; release-path.txt keeps pointing at ARM64 for the existing private release steps.
  if (!spike) await fs.writeFile(path.join(buildRoot, 'release-path-' + arch + '.txt'), exe);
  if (spike || arch === 'arm64') await fs.writeFile(path.join(buildRoot, spike ? 'spike-path.txt' : 'release-path.txt'), exe);
  console.log('Executable: ' + exe);
  return exe;
}
if (command === 'setup') await setup();
else if (command === 'spike') {
  const exe = await pack(true);
  await run(exe, ['--source-probe'], path.dirname(exe));
} else if (command === 'dev-spike') {
  await compile(true);
  await run(process.execPath, [path.join(buildRoot, 'node_modules/electron/install.js')], buildRoot);
  await run(path.join(buildRoot, 'node_modules/electron/dist/electron.exe'), [appDir], appDir);
} else if (command === 'build') { await compile(); console.log('Production build: ' + appDir); }
else if (command === 'package') await pack();
else if (command === 'dev') {
  await compile();
  await run(process.execPath, [path.join(buildRoot, 'node_modules/electron/install.js')], buildRoot);
  await run(path.join(buildRoot, 'node_modules/electron/dist/electron.exe'), [appDir], appDir);
} else if (command === 'typecheck') {
  await stage();
  await run(process.execPath, [path.join(buildRoot, 'node_modules/typescript/bin/tsc'), '--project', path.join(work, 'tsconfig.json')]);
} else if (command === 'lint') {
  await stage();
  await run(process.execPath, [path.join(buildRoot, 'node_modules/eslint/bin/eslint.js'), 'src', 'tests']);
} else if (command === 'test') {
  await stage();
  const esbuild = await moduleFrom('esbuild/lib/main.js');
  const files = (await fs.readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.test.ts'));
  await esbuild.build({ entryPoints: files.map(name => path.join(work, 'tests', name)), outdir: path.join(buildRoot, 'tests'), platform: 'node', format: 'esm', target: 'node24', bundle: true, packages: 'external', outExtension: { '.js': '.mjs' } });
  await run(process.execPath, ['--test', '--test-reporter=spec', ...files.map(name => path.join(buildRoot, 'tests', name.replace('.ts', '.mjs')))], root);
} else if (command === 'smoke') {
  await run(process.execPath, [path.join(root, 'tools/packaged-smoke.mjs'), ...process.argv.slice(3)], root);
} else throw new Error('Unknown build command.');
