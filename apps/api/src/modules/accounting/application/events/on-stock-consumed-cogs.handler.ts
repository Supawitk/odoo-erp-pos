import { Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { OrderStockConsumedEvent } from '../../../inventory/domain/events';
import { JournalRepository } from '../../infrastructure/journal.repository';
import { buildCogsEntry } from '../../domain/pos-journal-builders';

/**
 * COGS leg of a POS sale (or its reversal on a refund).
 *
 * Listens to `OrderStockConsumedEvent`, which the inventory stock handler
 * publishes after every line of an order has been written to stock_moves
 * (with layer-weighted unit costs). At that point we know exactly how much
 * inventory left the books and can post:
 *
 *   sale:    Dr 5100 COGS        / Cr 1161 Finished goods
 *   refund:  Dr 1161 Finished gd / Cr 5100 COGS
 *
 * The sale-side entry (revenue + VAT) is posted by the parallel
 * OnOrderCompletedJournalHandler. Splitting cogs into its own journal entry
 * mirrors Odoo / ERPNext: one entry per concern, two referenced by the same
 * source order. Voiding either is independent — useful when the cost basis
 * is later corrected via cycle-count without touching the revenue side.
 *
 * Idempotency: source_module='pos-cogs', source_id=orderId. Replays no-op.
 * Failures: logged, not retried — the order is already committed and the
 * sale-side entry is already in the GL. A backfill job (Phase 4 batch 2)
 * can replay missing COGS entries from stock_moves on demand.
 */
@Injectable()
@EventsHandler(OrderStockConsumedEvent)
export class OnStockConsumedCogsHandler
  implements IEventHandler<OrderStockConsumedEvent>
{
  private readonly logger = new Logger(OnStockConsumedCogsHandler.name);

  constructor(private readonly journals: JournalRepository) {}

  async handle(event: OrderStockConsumedEvent): Promise<void> {
    try {
      // Idempotency: O(1) lookup
      if (await this.journals.findBySource('pos-cogs', event.orderId)) {
        return;
      }

      const today = new Date().toISOString().slice(0, 10);
      const entry = buildCogsEntry({
        date: today,
        orderId: event.orderId,
        totalCostCents: event.totalCostCents,
        isRefund: event.isRefund,
        currency: event.currency,
      });

      const posted = await this.journals.insert(entry, { autoPost: true });
      this.logger.log(
        `Posted COGS journal ${posted.id} for ${event.isRefund ? 'refund' : 'sale'} ${event.orderId} (cost=${Math.abs(event.totalCostCents)} from ${event.costedLineCount} line(s))`,
      );
    } catch (e: any) {
      this.logger.error(
        `Failed to post COGS for order ${event.orderId}: ${e?.message ?? e}`,
        e?.stack,
      );
    }
  }
}
