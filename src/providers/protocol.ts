import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type Failure = 'signed-out' | 'offline' | 'throttled' | 'timeout' | 'unavailable' | 'compatibility' | 'changed' | 'stopped';
export class SourceError extends Error {
  constructor(public readonly kind: Failure, message: string = kind) { super(message); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const allowedRequests = new Set(['initialize', 'account/read', 'account/rateLimits/read']);
const hints = new Set(['account/updated', 'account/rateLimits/updated']);
const ignored = new Set(['mcpServer/startupStatus/updated', 'mcpServer/oauthLogin/completed', 'remoteControl/status/changed']);
export function classifyRpcError(error: unknown): SourceError {
  if (!record(error)) return new SourceError('compatibility');
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (/not authenticated|not signed in|unauthorized|authentication required/.test(message)) return new SourceError('signed-out');
  if (/too many requests|rate.limit|throttl/.test(message)) return new SourceError('throttled');
  if (/network|connect|dns|offline|error sending request/.test(message)) return new SourceError('offline');
  return new SourceError('unavailable');
}
type Pending = { resolve: (value: unknown) => void; reject: (error: SourceError) => void; timer: NodeJS.Timeout };
export class RpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private ended = false;
  private closing: Promise<void> | null = null;
  private abortSignal?: AbortSignal;
  private onAbort = () => this.fail(new SourceError('stopped'));
  readonly counts = { requests: 0, quotaReads: 0, hints: 0, ignored: 0, unknown: 0 };
  readonly exit: Promise<void>;
  readonly maxFrame = 1024 * 1024;

  constructor(executable: string, args: string[] = ['app-server', '--stdio'], private timeoutMs = 15000, signal?: AbortSignal) {
    super();
    if (signal?.aborted) throw new SourceError('stopped');
    this.abortSignal = signal;
    this.child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exit = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.consume(String(chunk)));
    // Discard diagnostics at ingress: the CLI may include private paths or account text.
    this.child.stderr.resume();
    this.child.on('error', () => this.fail(new SourceError('unavailable')));
    this.child.stdin.on('error', () => this.fail(new SourceError('unavailable')));
    this.child.on('exit', () => this.fail(new SourceError('unavailable')));
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }
  get pid(): number | undefined { return this.child.pid; }
  get alive(): boolean { return !this.ended; }
  request(method: string, params?: unknown): Promise<unknown> {
    if (!allowedRequests.has(method)) return Promise.reject(new SourceError('compatibility'));
    if (method === 'account/read' && (!record(params) || params.refreshToken !== false || Object.keys(params).length !== 1)) {
      return Promise.reject(new SourceError('compatibility'));
    }
    if (this.ended) return Promise.reject(new SourceError('stopped'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new SourceError('timeout')), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.counts.requests++;
      if (method === 'account/rateLimits/read') this.counts.quotaReads++;
      this.child.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  async initialize(): Promise<void> {
    const result = await this.request('initialize', { clientInfo: { name: 'limiter', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    if (!record(result)) throw new SourceError('compatibility');
    this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  private consume(chunk: string): void {
    if (this.ended) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxFrame) { this.fail(new SourceError('compatibility')); return; }
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { this.fail(new SourceError('compatibility')); return; }
      if (!record(message)) { this.fail(new SourceError('compatibility', 'Non-object JSON frame')); return; }
      if ('method' in message) {
        if ('id' in message || typeof message.method !== 'string') { this.fail(new SourceError('compatibility')); return; }
        if (hints.has(message.method)) {
          this.counts.hints++;
          this.emit('hint', message.method);
        } else if (ignored.has(message.method)) this.counts.ignored++;
        else { this.counts.unknown++; this.emit('unknown-method', message.method); this.fail(new SourceError('compatibility', 'Unexpected server notification')); return; }
      } else if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if ('error' in message) pending.reject(classifyRpcError(message.error));
        else if ('result' in message) pending.resolve(message.result);
        else pending.reject(new SourceError('compatibility'));
      } else { this.fail(new SourceError('compatibility')); return; }
    }
  }
  private fail(error: SourceError): void {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.emit('fault', error);
    this.child.stdin.destroy();
    this.child.kill();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.ended = true;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new SourceError('stopped')); }
      this.pending.clear();
      this.child.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
      if (timer) clearTimeout(timer);
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
      await this.exit;
      this.abortSignal?.removeEventListener('abort', this.onAbort);
      this.removeAllListeners();
    })();
    return this.closing;
  }
}
