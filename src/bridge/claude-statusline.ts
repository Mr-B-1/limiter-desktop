import { createConnection } from 'node:net';
import { claudePipe, statusLineSample } from '../providers/claude.js';

let input = '';
let bytes = 0;
process.stdin.on('data', (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) { process.stdin.destroy(); process.exitCode = 1; return; }
  input += chunk.toString('utf8');
});
process.stdin.on('end', () => {
  try {
    const sample = statusLineSample(JSON.parse(input));
    input = '';
    const weekly = sample.sevenDay;
    const short = sample.fiveHour;
    process.stdout.write('Claude' + (short ? ' 5h ' + short.usedPercent + '%' : '') + (weekly ? ' | Week ' + weekly.usedPercent + '%' : '') + '\n');
    const socket = createConnection(claudePipe());
    socket.setTimeout(300, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('connect', () => socket.end(JSON.stringify(sample) + '\n'));
  } catch { process.stdout.write('Claude\n'); }
});
process.stdin.on('error', () => { process.exitCode = 1; });
