import { Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Inject } from '@nestjs/common';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { OdooJsonRpcClient } from '../../../shared/infrastructure/odoo/odoo-jsonrpc.client';

interface OdooProduct {
  id: number;
  name: string;
  default_code: string | null;
  list_price: number;
  barcode: string | null;
  qty_available: number;
  write_date: string;
}

/**
 * Phase 3 Odoo catalog pull.
 *
 * Pulls product.product from Odoo into our local catalog using a
 * (write_date, id) cursor. Persists the cursor in custom.sync_log.
 *
 * Source-of-truth: Odoo is the product master; we are stock master. This cron
 * does NOT push prices/names back — that conflict path is silenced by design
 * (OCA convention).
 *
 * For Phase 3, this is the catalog skeleton — we capture upsert-by-Odoo-id and
 * defer the field-by-field merge plus Thai WHT fields to Phase 5 where the
 * three OCA `l10n_th_partner` fields land in `partners.wht_category`.
 */
@Injectable()
export class OdooCatalogPullService {
  private readonly logger = new Logger(OdooCatalogPullService.name);
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Optional() private readonly odoo: OdooJsonRpcClient | null,
  ) {}

  /**
   * Pull products since the last cursor in `sync_log`. Limits to 500/run to
   * keep tx scope small. Subsequent runs continue from where we left off.
   *
   * Triggered by BullMQ Job Scheduler (`odoo-catalog-pull`, every 5 min,
   * Asia/Bangkok). The `running` flag short-circuits if a previous tick is
   * still in flight; combined with BullMQ's queue lock this is multi-pod-safe.
   */
  async pull(): Promise<{ pulled: number; cursor: string }> {
    if (this.running) return { pulled: 0, cursor: '' };
    if (!this.odoo) return { pulled: 0, cursor: '' };
    this.running = true;
    try {
      return await this._pullInner();
    } catch (err) {
      this.logger.warn(`Catalog pull failed: ${(err as Error).message}`);
      return { pulled: 0, cursor: '' };
    } finally {
      this.running = false;
    }
  }

  private async _pullInner(): Promise<{ pulled: number; cursor: string }> {
    if (!this.odoo) return { pulled: 0, cursor: '' };
    const lastCursor = await this.getCursor('product.product');
    const domain: any[] = lastCursor ? [['write_date', '>=', lastCursor]] : [];

    const products = (await this.odoo.searchRead<OdooProduct>(
      'product.product',
      domain,
      ['name', 'default_code', 'list_price', 'barcode', 'qty_available', 'write_date'],
      { limit: 500, order: 'write_date asc, id asc' },
    )) as OdooProduct[];

    if (products.length === 0) {
      this.logger.debug('No new products since last cursor');
      return { pulled: 0, cursor: lastCursor };
    }

    // Upsert each. We don't touch our stock_qty (that's our master); we only
    // refresh the catalog metadata: name, sku, price, barcode.
    let upserts = 0;
    for (const p of products) {
      try {
        // Try to match an existing local row by barcode first (so locally-seeded
        // products gain their odoo_product_id mapping); fall back to insert.
        const existing = await this.db.execute<{ id: string }>(sql`
          SELECT id FROM custom.products
            WHERE odoo_product_id = ${p.id}
               OR (barcode IS NOT NULL AND barcode = ${p.barcode})
            LIMIT 1
        `);
        const existingRows = (existing as any).rows ?? (existing as any);

        if (existingRows.length > 0) {
          await this.db.execute(sql`
            UPDATE custom.products SET
              odoo_product_id = ${p.id},
              name            = ${p.name},
              sku             = ${p.default_code},
              price_cents     = ${Math.round(p.list_price * 100)},
              barcode         = COALESCE(${p.barcode}, barcode),
              updated_at      = NOW()
            WHERE id = ${existingRows[0].id}
          `);
        } else {
          await this.db.execute(sql`
            INSERT INTO custom.products
              (id, odoo_product_id, name, sku, price_cents, barcode, currency, is_active)
            VALUES (
              gen_random_uuid(),
              ${p.id},
              ${p.name},
              ${p.default_code},
              ${Math.round(p.list_price * 100)},
              ${p.barcode},
              'THB',
              true
            )
            ON CONFLICT (odoo_product_id) DO UPDATE SET
              name        = EXCLUDED.name,
              sku         = EXCLUDED.sku,
              price_cents = EXCLUDED.price_cents,
              barcode     = EXCLUDED.barcode,
              updated_at  = NOW()
          `);
        }
        upserts += 1;
      } catch (err) {
        this.logger.warn(`Skip Odoo product ${p.id} ${p.name}: ${(err as Error).message}`);
      }
    }

    const newCursor = products[products.length - 1].write_date;
    await this.setCursor('product.product', newCursor);
    this.logger.log(
      `Catalog pull: ${upserts}/${products.length} upserted, cursor → ${newCursor}`,
    );
    return { pulled: upserts, cursor: newCursor };
  }

  private async getCursor(model: string): Promise<string> {
    const r = await this.db.execute<{ data_hash: string }>(sql`
      SELECT data_hash FROM custom.sync_log
       WHERE model = ${model} AND direction = 'odoo_to_local' AND status = 'success'
       ORDER BY synced_at DESC LIMIT 1
    `);
    const rows = (r as any).rows ?? (r as any);
    return rows[0]?.data_hash ?? '';
  }

  private async setCursor(model: string, cursor: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO custom.sync_log (id, model, odoo_id, direction, status, data_hash, synced_at)
      VALUES (gen_random_uuid(), ${model}, 0, 'odoo_to_local', 'success', ${cursor}, NOW())
    `);
  }
}
