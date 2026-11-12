import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { connectCodex } from './providers/codex-discovery.js';
import { record } from './providers/protocol.js';

async function main(): Promise<void> {
const local = process.env.LOCALAPPDATA;
if (!local) throw new Error('Host-local storage unavailable.');
const buildRoot = path.join(local, 'Limiter-build');
app.setPath('userData', path.join(buildRoot, 'spike-profile'));
await app.whenReady();
let result: Record<string, unknown> = { scope: 'packaged ARM64 Codex source spike', packaged: app.isPackaged, modelTurnsStarted: 0 };
let client;
try {
  const connection = await connectCodex(path.join(buildRoot, 'spike-source'));
  client = connection.client;
  const account = await client.request('account/read', { refreshToken: false });
  if (!record(account) || !record(account.account) || account.account.type !== 'chatgpt') throw new Error('ChatGPT account unavailable');
  const reads: unknown[] = [];
  for (let index = 0; index < 2; index++) {
    const value = await client.request('account/rateLimits/read');
    if (!record(value) || (!record(value.rateLimitsByLimitId) && !record(value.rateLimits))) throw new Error('Quota response invalid');
    const buckets = record(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId : { legacy: value.rateLimits };
    const windows = Object.entries(buckets).flatMap(([id, bucket]) => !record(bucket) ? [] : ['primary', 'secondary'].flatMap(slot => {
      const window = bucket[slot];
      return record(window) ? [{ bucket: id, slot, usedPercent: window.usedPercent, windowDurationMins: window.windowDurationMins, resetsAt: window.resetsAt }] : [];
    }));
    if (!windows.length) throw new Error('No windows returned');
    reads.push({ observedAt: Date.now(), windows });
  }
  const pid = client.pid;
  await client.close();
  let childAbsent = false;
  try { if (pid) process.kill(pid, 0); } catch { childAbsent = true; }
  result = { ...result, candidate: connection.candidate, authType: 'chatgpt', reads, counts: client.counts, childPid: pid, childAbsent, result: childAbsent ? 'PASS' : 'FAIL' };
} catch (error) {
  result = { ...result, result: 'FAIL', reason: error instanceof Error ? error.message : 'Source probe failed' };
} finally {
  await client?.close();
  await fs.writeFile(path.join(buildRoot, app.isPackaged ? 'spike-receipt.json' : 'dev-spike-receipt.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.result === 'PASS' ? 0 : 1);
}

}
void main().catch(() => app.exit(1));
