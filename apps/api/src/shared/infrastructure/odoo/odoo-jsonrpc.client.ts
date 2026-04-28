import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import CircuitBreaker = require('opossum');

interface OdooConfig {
  url: string;
  db: string;
  username: string;
  password: string;
}

/**
 * Odoo JSON-RPC client wrapped in an opossum 9.x circuit breaker.
 *
 * Threshold + window:
 *   - errorThresholdPercentage 50% (trip if half of recent calls failed)
 *   - rollingCountTimeout 30s, rollingCountBuckets 10 (3s buckets)
 *   - volumeThreshold 5 (need 5 calls in window before considering trip)
 *   - resetTimeout 60s (open → half-open after 60s)
 *
 * When OPEN: every call short-circuits immediately with a "circuit open" error.
 * Downstream callers (catalog pull, outbox relay, reconciliation, the
 * health indicator) are written to log+continue when Odoo is unavailable, so
 * the breaker simply makes the failure mode fast + observable instead of
 * slow + hung-on-timeout.
 */
@Injectable()
export class OdooJsonRpcClient implements OnModuleInit {
  private readonly logger = new Logger(OdooJsonRpcClient.name);
  private sessionId: string | null = null;
  private uid: number | null = null;
  private config: OdooConfig;
  private breaker!: CircuitBreaker<[string, any], any>;

  constructor() {
    this.config = {
      url: process.env.ODOO_URL || 'http://localhost:8069',
      db: process.env.ODOO_DB || 'odoo',
      username: process.env.ODOO_ADMIN_USER || 'admin',
      password: process.env.ODOO_ADMIN_PASSWORD || 'admin',
    };

    // Bind the breaker around the raw fetch wrapper.
    this.breaker = new CircuitBreaker(
      (endpoint: string, params: any) => this.rawCall(endpoint, params),
      {
        timeout: 30_000,
        errorThresholdPercentage: 50,
        resetTimeout: 60_000,
        rollingCountTimeout: 30_000,
        rollingCountBuckets: 10,
        volumeThreshold: 5,
        name: 'odoo-jsonrpc',
      },
    );

    this.breaker.on('open', () =>
      this.logger.error(
        `Odoo circuit breaker OPENED — short-circuiting until ${new Date(Date.now() + 60_000).toISOString()}`,
      ),
    );
    this.breaker.on('halfOpen', () =>
      this.logger.warn('Odoo circuit breaker half-open — probing'),
    );
    this.breaker.on('close', () =>
      this.logger.log('Odoo circuit breaker CLOSED — connection restored'),
    );
  }

  async onModuleInit() {
    try {
      await this.authenticate();
      this.logger.log(`Connected to Odoo at ${this.config.url}`);
    } catch (error) {
      this.logger.warn(
        `Odoo not available at ${this.config.url} — will retry on first request`,
      );
    }
  }

  async authenticate(): Promise<void> {
    const response = await this.call('/web/session/authenticate', {
      db: this.config.db,
      login: this.config.username,
      password: this.config.password,
    });

    this.uid = response.uid;

    if (response.session_id) {
      this.sessionId = response.session_id;
    }
  }

  async searchRead<T = any>(
    model: string,
    domain: any[] = [],
    fields: string[] = [],
    options?: { limit?: number; offset?: number; order?: string },
  ): Promise<T[]> {
    const result = await this.call('/web/dataset/call_kw', {
      model,
      method: 'search_read',
      args: [domain],
      kwargs: {
        fields,
        limit: options?.limit || 80,
        offset: options?.offset || 0,
        order: options?.order || 'id asc',
      },
    });
    return result;
  }

  async create(model: string, values: Record<string, any>): Promise<number> {
    return this.call('/web/dataset/call_kw', {
      model,
      method: 'create',
      args: [values],
      kwargs: {},
    });
  }

  async write(
    model: string,
    ids: number[],
    values: Record<string, any>,
  ): Promise<boolean> {
    return this.call('/web/dataset/call_kw', {
      model,
      method: 'write',
      args: [ids, values],
      kwargs: {},
    });
  }

  isConnected(): boolean {
    return this.uid !== null;
  }

  /** Whether the breaker is currently open. Useful for the health indicator. */
  isCircuitOpen(): boolean {
    return this.breaker.opened;
  }

  /** Breaker stats for /health drilldown (Phase 5). */
  getBreakerStats(): { state: 'closed' | 'half-open' | 'open'; stats: Record<string, number> } {
    const state: 'closed' | 'half-open' | 'open' =
      this.breaker.opened ? 'open' : this.breaker.halfOpen ? 'half-open' : 'closed';
    const s: any = (this.breaker as any).stats ?? {};
    return {
      state,
      stats: {
        successes: Number(s.successes ?? 0),
        failures: Number(s.failures ?? 0),
        rejects: Number(s.rejects ?? 0),
        timeouts: Number(s.timeouts ?? 0),
        fires: Number(s.fires ?? 0),
      },
    };
  }

  /** All caller paths go through this — opossum-wrapped. */
  private async call(endpoint: string, params: any): Promise<any> {
    return this.breaker.fire(endpoint, params);
  }

  /** The actual fetch — only the breaker invokes this. */
  private async rawCall(endpoint: string, params: any): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.sessionId) headers['Cookie'] = `session_id=${this.sessionId}`;

    const response = await fetch(`${this.config.url}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'call', params }),
      signal: AbortSignal.timeout(30_000),
    });

    const data = await response.json();

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/session_id=([^;]+)/);
      if (match) this.sessionId = match[1];
    }

    if (data.error) {
      throw new Error(
        `Odoo API Error: ${data.error.message || JSON.stringify(data.error.data)}`,
      );
    }

    return data.result;
  }
}
