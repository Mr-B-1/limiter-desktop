import readline from 'node:readline';
const mode = process.argv[2] || 'normal';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialized') {
    if (mode === 'sparse') console.log(JSON.stringify({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: null } } }));
    if (mode === 'unknown') console.log(JSON.stringify({ method: 'unsafe/action', params: { value: 'ignored' } }));
    if (mode === 'ignored') console.log(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }));
    return;
  }
  if (request.method !== 'initialize') {
    if (mode === 'timeout') return;
    if (mode === 'crash') process.exit(2);
    if (mode === 'malformed') { console.log('{broken'); return; }
    if (mode === 'oversize') { console.log('x'.repeat(1024 * 1024 + 1)); return; }
    if (mode === 'wrong-id') { console.log(JSON.stringify({ id: request.id + 99, result: {} })); return; }
    if (mode === 'offline') { console.log(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Network connection failed' } })); return; }
    if (mode === 'throttled') { console.log(JSON.stringify({ id: request.id, error: { code: -32000, message: 'Too many requests' } })); return; }
  }
  let result = {};
  if (request.method === 'account/read') result = { account: mode === 'signed-out' ? null : { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'pro' } };
  if (request.method === 'account/rateLimits/read') result = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 2000000000 } } } };
  console.log(JSON.stringify({ id: request.id, result }));
});
