import { Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { OdooJsonRpcClient } from '../../../shared/infrastructure/odoo/odoo-jsonrpc.client';

/**
 * Nightly reconciliation: compare local stock_quants vs Odoo qty_available
 * for each product mapped via odoo_id. Writes a sync_log row per drift; does
 * NOT auto-resolve.
 *
 * Phase 3 implementation surfaces drift = our_qty − odoo_qty per product;
 * surfaces it via /api/inventory/reconciliation-drift. Phase 4 will gate
 * journal-entry posting on drift = 0.
 */
@Injectable()
export class ReconciliationCronService {
  private readonly logger = new Logger(ReconciliationCronService.name);
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Optional() private readonly odoo: OdooJsonRpcClient | null,
  ) {}

  /**
   * Daily reconciliation. Triggered by BullMQ Job Scheduler
   * (`odoo-stock-reconcile`, 02:30 Asia/Bangkok). Multi-pod-safe via the
   * BullMQ queue lock + the in-process `running` guard.
   */
  async run(): Promise<{ matched: number; drifted: number; unmapped: number }> {
    if (this.running) return { matched: 0, drifted: 0, unmapped: 0 };
    if (!this.odoo) return { matched: 0, drifted: 0, unmapped: 0 };
    this.running = true;
    try {
      return await this._reconcile();
    } finally {
      this.running = false;
    }
  }

  private async _reconcile(): Promise<{ matched: number; drifted: number; unmapped: number }> {
    if (!this.odoo) return { matched: 0, drifted: 0, unmapped: 0 };

    const localRows = await this.db.execute<{
      product_id: string;
      odoo_product_id: number | null;
      qty_on_hand: string;
      product_name: string;
    }>(sql`
      SELECT q.product_id::text AS product_id,
             p.odoo_product_id,
             SUM(q.qty_on_hand)::text AS qty_on_hand,
             p.name AS product_name
        FROM custom.stock_quants q
        JOIN custom.products p ON p.id = q.product_id
       WHERE p.odoo_product_id IS NOT NULL
       GROUP BY q.product_id, p.odoo_product_id, p.name
    `);
    const localList = ((localRows as any).rows ?? (localRows as any)) as Array<any>;

    let matched = 0;
    let drifted = 0;
    let unmapped = 0;

    for (const lr of localList) {
      try {
        const odooRows = await this.odoo.searchRead<{
          id: number;
          qty_available: number;
        }>('product.product', [['id', '=', lr.odoo_product_id]], ['qty_available'], { limit: 1 });
        const odooQty = odooRows[0]?.qty_available ?? null;
        if (odooQty == null) {
          unmapped += 1;
          continue;
        }
        const ourQty = Number(lr.qty_on_hand);
        const diff = ourQty - odooQty;
        if (Math.abs(diff) > 0.001) {
          drifted += 1;
          await this.db.execute(sql`
            INSERT INTO custom.sync_log (id, model, odoo_id, direction, status, data_hash, error_message, synced_at)
            VALUES (
              gen_random_uuid(),
              'product.product',
              ${lr.odoo_product_id},
              'odoo_to_local',
              'conflict',
              ${`drift=${diff}`},
              ${`product=${lr.product_name} our_qty=${ourQty} odoo_qty=${odooQty}`},
              NOW()
            )
          `);
        } else {
          matched += 1;
        }
      } catch (err) {
        this.logger.warn(
          `Reconcile fail product=${lr.product_id} odoo_id=${lr.odoo_product_id}: ${(err as Error).message}`,
        );
        unmapped += 1;
      }
    }

    return { matched, drifted, unmapped };
  }

  /** Returns recent drift entries for the dashboard. */
  async recentDrift(limit = 50) {
    const rows = await this.db.execute<{
      odoo_id: number;
      data_hash: string;
      error_message: string;
      synced_at: Date;
    }>(sql`
      SELECT odoo_id, data_hash, error_message, synced_at
        FROM custom.sync_log
       WHERE model = 'product.product'
         AND status = 'conflict'
       ORDER BY synced_at DESC
       LIMIT ${limit}
    `);
    return ((rows as any).rows ?? (rows as any)).map((r: any) => ({
      odooId: Number(r.odoo_id),
      drift: r.data_hash,
      message: r.error_message,
      checkedAt: r.synced_at,
    }));
  }
}
