import { EventEmitter } from 'node:events';
import { connectCodex, type Candidate } from './codex-discovery.js';
import { SourceError, record, type RpcClient } from './protocol.js';
import { parseQuota } from './quota.js';
import type { QuotaSnapshot } from '../shared/usage.js';

export type SourceConnection = { candidate: Candidate; client: RpcClient };
export type Connector = (signal: AbortSignal) => Promise<SourceConnection>;
export class CodexProvider extends EventEmitter {
  private connection: SourceConnection | null = null;
  private generation = 0;
  private identity: string | null = null;
  private stopped = false;
  private controller = new AbortController();
  private pending: Promise<QuotaSnapshot> | null = null;
  private connecting: Promise<SourceConnection> | null = null;
  constructor(private connector: Connector) { super(); }
  static local(root: string, explicit?: string, previous?: string): CodexProvider {
    return new CodexProvider(signal => connectCodex(root, explicit, previous, signal));
  }
  get candidate(): Candidate | null { return this.connection?.candidate || null; }
  get pid(): number | undefined { return this.connection?.client.pid; }
  get counts(): Record<string, number> { return this.connection?.client.counts || {}; }
  private invalidate(): void {
    this.generation++;
    this.identity = null;
    this.emit('invalidate');
  }
  private async connect(): Promise<SourceConnection> {
    if (this.connection?.client.alive) return this.connection;
    if (this.connecting) return this.connecting;
    this.invalidate();
    this.connecting = (async () => {
      await this.connection?.client.close();
      const connection = await this.connector(this.controller.signal);
      if (this.stopped) { await connection.client.close(); throw new SourceError('stopped'); }
      this.connection = connection;
      connection.client.on('hint', (method: string) => {
        if (method === 'account/updated') this.invalidate();
        this.emit('hint');
      });
      connection.client.on('fault', (error: SourceError) => {
        this.invalidate();
        this.emit('source-fault', error);
      });
      return connection;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  private account(value: unknown): { identity: string | null; plan: string } {
    if (!record(value)) throw new SourceError('compatibility');
    if (value.account === null) throw new SourceError('signed-out');
    if (!record(value.account)) throw new SourceError('compatibility');
    if (value.account.type !== 'chatgpt') throw new SourceError('unavailable');
    const account = value.account;
    for (const key of ['email', 'accountId', 'planType']) {
      if (account[key] !== undefined && account[key] !== null && typeof account[key] !== 'string') throw new SourceError('compatibility');
    }
    const identity = typeof account.email === 'string' ? account.email : typeof account.accountId === 'string' ? account.accountId : null;
    const plan = typeof account.planType === 'string' ? account.planType : 'unknown';
    return { identity: identity === null ? null : identity + ':' + plan, plan };
  }
  read(): Promise<QuotaSnapshot> {
    if (this.stopped) return Promise.reject(new SourceError('stopped'));
    if (this.pending) return this.pending;
    this.pending = this.perform();
    return this.pending.finally(() => { this.pending = null; });
  }
  private async perform(): Promise<QuotaSnapshot> {
    try {
      const { client } = await this.connect();
      const initialGeneration = this.generation;
      const before = this.account(await client.request('account/read', { refreshToken: false }));
      if (this.stopped || initialGeneration !== this.generation) throw new SourceError('changed');
      if (this.identity !== null && this.identity !== before.identity) this.invalidate();
      this.identity = before.identity;
      const generation = this.generation;
      // Codex's own client sends this on background polls so the reply skips reset-credit detail.
      const limits = await client.request('account/rateLimits/read', { excludeResetCreditDetails: true });
      const after = this.account(await client.request('account/read', { refreshToken: false }));
      if (this.stopped || generation !== this.generation || before.identity !== after.identity) {
        if (!this.stopped) this.invalidate();
        throw new SourceError('changed');
      }
      return parseQuota(limits, generation, after.plan, after.identity !== null);
    } catch (error) {
      if (error instanceof SourceError && ['signed-out', 'compatibility', 'unavailable'].includes(error.kind)) this.invalidate();
      throw error;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    this.invalidate();
    await this.connection?.client.close();
    if (this.connecting) { try { await this.connecting; } catch { /* Connect closes its own late child. */ } }
    if (this.pending) { try { await this.pending; } catch { /* Shutdown invalidates the pending operation. */ } }
    this.removeAllListeners();
  }
}
