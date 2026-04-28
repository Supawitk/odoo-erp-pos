import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { Logger, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { posOrders, type Database } from '@erp/db';
import { OrderCompletedEvent } from '../../domain/events';
import { OdooJsonRpcClient } from '../../../../shared/infrastructure/odoo/odoo-jsonrpc.client';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';

/**
 * Odoo sync handler. Best-effort; never blocks the POS.
 *
 * Strategy on each OrderCompletedEvent:
 *  1. Resolve (or lazily bootstrap) a dedicated Odoo POS config +
 *     open pos.session called "ERP-POS Gateway". Cached in memory.
 *  2. Push the order into `pos.order` with session_id set.
 *  3. Store odoo_order_id back on the local row.
 *
 * Failure modes:
 *   - Odoo down → log warning, leave odooOrderId null. Phase 3 reconciler
 *     will retry.
 *   - Bootstrap fails → same, warn + degrade.
 */
@EventsHandler(OrderCompletedEvent)
export class OnOrderCompletedOdooSync implements IEventHandler<OrderCompletedEvent> {
  private readonly logger = new Logger(OnOrderCompletedOdooSync.name);
  private cachedSessionId: number | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly odoo: OdooJsonRpcClient,
  ) {}

  async handle(event: OrderCompletedEvent) {
    try {
      const [row] = await this.db
        .select()
        .from(posOrders)
        .where(eq(posOrders.id, event.orderId))
        .limit(1);
      if (!row) return;
      if (row.odooOrderId) return;

      const sessionId = await this.ensureOdooSession();

      // Total line quantity — Odoo wants session_order_count-like seeds
      const payload = {
        name: row.documentNumber ?? `POS/${row.id.slice(0, 8)}`,
        amount_total: row.totalCents / 100,
        amount_tax: row.taxCents / 100,
        amount_paid: row.totalCents / 100,
        amount_return: 0,
        session_id: sessionId,
        state: row.status === 'refunded' ? 'cancel' : 'paid',
        pos_reference: row.id,
      };

      const odooId = await this.odoo.create('pos.order', payload);
      await this.db
        .update(posOrders)
        .set({ odooOrderId: odooId, updatedAt: new Date() })
        .where(eq(posOrders.id, row.id));

      this.logger.log(`Order ${row.documentNumber} → Odoo pos.order id=${odooId} (session ${sessionId})`);
    } catch (err: any) {
      this.logger.warn(
        `Odoo sync failed for order ${event.orderId}: ${err?.message ?? err}. Order persisted locally; retry later.`,
      );
    }
  }

  /**
   * Ensure a usable Odoo pos.session exists and cache its ID.
   * Creates config + session the first time through.
   */
  private async ensureOdooSession(): Promise<number> {
    if (this.cachedSessionId) return this.cachedSessionId;

    // Try: find an open session for our dedicated config
    const gatewayName = 'ERP-POS Gateway';
    const configs = await this.odoo.searchRead<{ id: number }>(
      'pos.config',
      [['name', '=', gatewayName]],
      ['id'],
    );

    let configId: number;
    if (configs.length > 0) {
      configId = configs[0].id;
    } else {
      configId = await this.odoo.create('pos.config', { name: gatewayName });
      this.logger.log(`Created Odoo pos.config id=${configId}`);
    }

    const openSessions = await this.odoo.searchRead<{ id: number }>(
      'pos.session',
      [
        ['config_id', '=', configId],
        ['state', 'in', ['opening_control', 'opened']],
      ],
      ['id'],
    );

    if (openSessions.length > 0) {
      this.cachedSessionId = openSessions[0].id;
      return this.cachedSessionId;
    }

    const sessionId = await this.odoo.create('pos.session', { config_id: configId });
    this.logger.log(`Created Odoo pos.session id=${sessionId}`);
    this.cachedSessionId = sessionId;
    return sessionId;
  }
}
