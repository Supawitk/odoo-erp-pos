import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { OdooJsonRpcClient } from './odoo-jsonrpc.client';

@Injectable()
export class OdooHealthIndicator extends HealthIndicator {
  constructor(private readonly odoo: OdooJsonRpcClient) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    // Degraded-OK: Odoo is an optional upstream. Report status, never throw.
    const connected = this.odoo.isConnected();
    return this.getStatus(key, true, {
      connected,
      mode: connected ? 'online' : 'degraded',
    });
  }
}
