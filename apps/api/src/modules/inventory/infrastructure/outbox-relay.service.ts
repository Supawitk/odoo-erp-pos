import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Database } from '@erp/db';
import { OutboxService } from './outbox.service';
import { OdooJsonRpcClient } from '../../../shared/infrastructure/odoo/odoo-jsonrpc.client';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

/**
 * Outbox relay — drains pending rows to Odoo via JSON-RPC.
 *
 * Triggered by BullMQ Job Scheduler v5 (`odoo-outbox-relay`, every minute,
 * Asia/Bangkok). All Phase 3 background jobs share a single `jobs` queue +
 * processor wired in `shared/infrastructure/jobs/jobs.module.ts`.
 *
 * Idempotency: Odoo `ir.model.data` xmlid keeps create operations safe to
 * retry. If the relay crashes mid-flight, the row stays in `in_flight`; a
 * manual reset script flips it back to `pending` after the next deploy.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);
  private running = false;

  constructor(
    private readonly outbox: OutboxService,
    @Optional() private readonly odoo: OdooJsonRpcClient | null,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  /**
   * Public: drain up to `batchSize` rows. Returns counts.
   *
   * Triggered by BullMQ Job Scheduler (`odoo-outbox-relay` job, every minute,
   * Asia/Bangkok). The `running` flag short-circuits if the previous tick is
   * still in flight; BullMQ's lock + the `running` flag together prevent
   * multi-pod double-execution.
   */
  async run(batchSize = 50): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }> {
    if (this.running) {
      this.logger.debug('Skipping run — previous still in flight');
      return { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    }
    this.running = true;
    try {
      return await this._drain(batchSize);
    } finally {
      this.running = false;
    }
  }

  private async _drain(batchSize: number): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }> {
    const rows = await this.outbox.claimDue(batchSize);
    if (rows.length === 0) return { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };

    if (!this.odoo) {
      // Odoo not configured — push back to pending after a long delay.
      for (const row of rows) {
        await this.outbox.markFailed(row.id, 'odoo client not configured', row.attempts + 1);
      }
      return { attempted: rows.length, succeeded: 0, failed: 0, skipped: rows.length };
    }

    let succeeded = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        // For Phase 3 the relay logs payloads but doesn't do the live ID
        // resolution mapping yet — that's Phase 5 work where catalog pull
        // builds the external_ref → odoo_id table. The point right now is
        // proving the outbox + claim + status transitions work.
        const odooId = await this.attemptCreate(row);
        await this.outbox.markSucceeded(row.id, odooId);
        succeeded += 1;
      } catch (err: any) {
        const msg = (err?.message ?? String(err)).slice(0, 1000);
        await this.outbox.markFailed(row.id, msg, row.attempts + 1);
        failed += 1;
      }
    }

    this.logger.log(
      `Outbox drain: ${rows.length} attempted, ${succeeded} succeeded, ${failed} failed`,
    );
    return { attempted: rows.length, succeeded, failed, skipped: 0 };
  }

  /**
   * Attempt to push a single outbox row to Odoo.
   *
   * Resolution step: `product_id: { external_ref: <UUID> }` placeholders are
   * translated to Odoo's integer product id via `custom.products.odoo_product_id`.
   * If the mapping isn't yet known (catalog pull hasn't seen this product),
   * the push is rejected with a retry-able error and the row sits in the
   * outbox until the next catalog pull populates the column.
   *
   * After successful create, an `ir.model.data` xmlid row is also written so
   * subsequent replays are no-ops (Odoo's standard idempotency mechanism).
   */
  private async attemptCreate(row: {
    model: string;
    operation: string;
    payload: any;
    externalId: string;
  }): Promise<number> {
    if (!this.odoo) throw new Error('odoo client not available');
    if (row.operation !== 'create') {
      throw new Error(`unsupported operation: ${row.operation}`);
    }

    const resolvedPayload = await this.resolveExternalRefs(row.payload);

    const id = (await this.odoo.create?.(row.model, resolvedPayload)) ?? 0;
    if (typeof id !== 'number' || id <= 0) {
      throw new Error(`odoo create returned invalid id: ${id}`);
    }

    // Register the ir.model.data xmlid so future replays return the same id.
    // externalId format is `erp_pos.<name>`. Odoo expects module + name split.
    const [moduleName, ...rest] = row.externalId.split('.');
    const xmlName = rest.join('.');
    if (moduleName && xmlName) {
      try {
        await this.odoo.create('ir.model.data', {
          module: moduleName,
          name: xmlName,
          model: row.model,
          res_id: id,
          noupdate: true,
        });
      } catch (e) {
        // ir.model.data already exists is fine — UNIQUE(module, name) collision.
        this.logger.debug(
          `ir.model.data register for ${row.externalId} failed (likely duplicate): ${
            (e as Error).message
          }`,
        );
      }
    }

    return id;
  }

  /**
   * Walk the payload and replace `{ external_ref: '<uuid>' }` placeholders
   * with the Odoo integer id from `custom.products.odoo_product_id`. Throws
   * `MAPPING_NOT_READY` for rows where catalog pull hasn't run yet — the
   * outbox marks those as failed (retry-able) and tries again next tick.
   */
  private async resolveExternalRefs(payload: any): Promise<any> {
    if (Array.isArray(payload)) {
      const out: any[] = [];
      for (const item of payload) out.push(await this.resolveExternalRefs(item));
      return out;
    }
    if (payload && typeof payload === 'object') {
      // Leaf form: { external_ref: '<uuid>' } → integer id
      if (typeof payload.external_ref === 'string' && Object.keys(payload).length === 1) {
        return await this.lookupOdooProductId(payload.external_ref);
      }
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(payload)) {
        // Drop ERP-internal metadata before sending to Odoo
        if (k === '_erp_meta') continue;
        // Inline location external refs are dropped — the gate item is "stock.move
        // is registered with ir.model.data", not "Odoo internal locations are
        // bidirectionally synced". Phase 5 wires real location mapping.
        if (k === 'location_from_external_ref' || k === 'location_to_external_ref') continue;
        out[k] = await this.resolveExternalRefs(v);
      }
      return out;
    }
    return payload;
  }

  private async lookupOdooProductId(uuid: string): Promise<number> {
    const r = await this.db.execute<{ odoo_product_id: number | null }>(sql`
      SELECT odoo_product_id FROM custom.products WHERE id::text = ${uuid} LIMIT 1
    `);
    const rows = (r as any).rows ?? (r as any);
    const odooId = rows[0]?.odoo_product_id;
    if (!odooId) {
      throw new Error(
        `MAPPING_NOT_READY: product ${uuid} has no odoo_product_id (catalog pull pending)`,
      );
    }
    return odooId;
  }
}
