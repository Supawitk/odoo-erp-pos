import { Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { OrderStockConsumedEvent } from '../../../inventory/domain/events';
import { JournalEntry } from '../../domain/journal-entry';
import { JournalRepository } from '../../infrastructure/journal.repository';

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
      // Idempotency check
      const existing = await this.journals.list({
        sourceModule: 'pos-cogs',
        limit: 500,
      });
      if (existing.some((e) => e.sourceId === event.orderId)) {
        return;
      }

      const today = new Date().toISOString().slice(0, 10);
      const cost = Math.abs(event.totalCostCents);

      const lines = event.isRefund
        ? [
            // Reverse: inventory back, COGS down
            {
              accountCode: '1161',
              accountName: 'Finished goods',
              debitCents: cost,
              creditCents: 0,
            },
            {
              accountCode: '5100',
              accountName: 'COGS — products',
              debitCents: 0,
              creditCents: cost,
            },
          ]
        : [
            {
              accountCode: '5100',
              accountName: 'COGS — products',
              debitCents: cost,
              creditCents: 0,
            },
            {
              accountCode: '1161',
              accountName: 'Finished goods',
              debitCents: 0,
              creditCents: cost,
            },
          ];

      const entry = JournalEntry.create({
        date: today,
        description: event.isRefund
          ? `COGS reversal for refund ${event.orderId.slice(0, 8)}`
          : `COGS for sale ${event.orderId.slice(0, 8)}`,
        reference: null,
        sourceModule: 'pos-cogs',
        sourceId: event.orderId,
        currency: event.currency,
        lines,
      });

      const posted = await this.journals.insert(entry, { autoPost: true });
      this.logger.log(
        `Posted COGS journal ${posted.id} for ${event.isRefund ? 'refund' : 'sale'} ${event.orderId} (cost=${cost} from ${event.costedLineCount} line(s))`,
      );
    } catch (e: any) {
      this.logger.error(
        `Failed to post COGS for order ${event.orderId}: ${e?.message ?? e}`,
        e?.stack,
      );
    }
  }
}
