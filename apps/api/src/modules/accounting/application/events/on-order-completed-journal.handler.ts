import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { eq } from 'drizzle-orm';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { OrderCompletedEvent } from '../../../pos/domain/events';
import { JournalEntry } from '../../domain/journal-entry';
import { JournalRepository } from '../../infrastructure/journal.repository';

/**
 * POS sale → journal entry, double-entry style.
 *
 * Patterns supported in this batch:
 *
 *   Cash sale (RE / ABB / TX, paymentMethod=cash):
 *     Dr 1110 Cash on hand          gross
 *       Cr 4110 Sales revenue       net
 *       Cr 2201 Output VAT          vat
 *
 *   Card sale (paymentMethod=card):
 *     Dr 1135 Card settlement       gross
 *       Cr 4110 Sales revenue       net
 *       Cr 2201 Output VAT          vat
 *
 *   PromptPay (paymentMethod=promptpay):
 *     Dr 1120 Bank — checking       gross
 *       Cr 4110 Sales revenue       net
 *       Cr 2201 Output VAT          vat
 *
 *   Refund / Credit Note (documentType=CN):
 *     Dr 4140 Sales returns         net
 *     Dr 2201 Output VAT            vat   (VAT on the original is reversed)
 *       Cr 1110 / 1135 / 1120       gross   (refund the same channel)
 *
 * COGS posting (Dr 5100 / Cr 1161) is deferred until cost averaging is wired
 * into the order line — current Phase 3 valuation lives on cost layers but
 * isn't yet snapshotted on each order line. Phase 4 batch 2 will add it.
 *
 * Handler is best-effort: if the post fails (unknown account, DB error,
 * etc.) it logs and moves on. The order is already committed; replay is
 * possible later from `pos_orders.id`. Outbox-durable replay is a follow-up
 * (Phase 4 batch 2).
 */
@Injectable()
@EventsHandler(OrderCompletedEvent)
export class OnOrderCompletedJournalHandler
  implements IEventHandler<OrderCompletedEvent>
{
  private readonly logger = new Logger(OnOrderCompletedJournalHandler.name);

  constructor(
    private readonly journals: JournalRepository,
    @Inject(DRIZZLE) private readonly db: Database,
  ) {}

  async handle(event: OrderCompletedEvent): Promise<void> {
    try {
      // Pull the canonical order. The event only carries the gross total;
      // accounting needs net + VAT + payment method + document type.
      const rows = await this.db
        .select()
        .from(posOrders)
        .where(eq(posOrders.id, event.orderId))
        .limit(1);
      const order = rows[0];
      if (!order) {
        this.logger.warn(`Order ${event.orderId} not found at journal-post time`);
        return;
      }

      // Idempotency: if a posted entry with this source already exists, skip.
      const existing = await this.journals.list({
        sourceModule: 'pos',
        limit: 500,
      });
      if (existing.some((e) => e.sourceId === order.id)) {
        return;
      }

      const total = Number(order.totalCents);
      const vat = vatFromBreakdown(order.vatBreakdown);
      const net = total - vat;
      const isRefund = order.documentType === 'CN';
      const channelAccount = paymentToAccount(order.paymentMethod);

      const entry = isRefund
        ? buildRefundEntry({
            date: dateOnly(order.createdAt as Date | string | null),
            orderId: order.id,
            documentNumber: order.documentNumber,
            channelAccount,
            netCents: Math.abs(net),
            vatCents: Math.abs(vat),
            currency: order.currency,
          })
        : buildSaleEntry({
            date: dateOnly(order.createdAt as Date | string | null),
            orderId: order.id,
            documentNumber: order.documentNumber,
            channelAccount,
            netCents: net,
            vatCents: vat,
            currency: order.currency,
          });

      const posted = await this.journals.insert(entry, { autoPost: true });
      this.logger.log(
        `Posted journal ${posted.id} for ${order.documentType} ${order.documentNumber ?? order.id} (channel=${channelAccount} net=${net} vat=${vat})`,
      );
    } catch (e: any) {
      // Don't crash the event handler — accounting failure must not break
      // POS / inventory / Odoo sync. Log, surface, and replay later.
      this.logger.error(
        `Failed to post journal for order ${event.orderId}: ${e?.message ?? e}`,
        e?.stack,
      );
    }
  }
}

function paymentToAccount(method: string): string {
  switch (method) {
    case 'cash':
      return '1110'; // Cash on hand
    case 'card':
      return '1135'; // Card settlement in transit
    case 'promptpay':
    case 'qr':
      return '1120'; // Bank — checking
    default:
      return '1110';
  }
}

function vatFromBreakdown(v: unknown): number {
  if (!v || typeof v !== 'object') return 0;
  const obj = v as Record<string, unknown>;
  if (typeof obj.totalVatCents === 'number') return obj.totalVatCents;
  if (typeof obj.vatCents === 'number') return obj.vatCents;
  if (Array.isArray(obj.lines)) {
    return obj.lines.reduce(
      (s: number, l: any) => s + (Number(l?.vatCents) || 0),
      0,
    );
  }
  return 0;
}

function dateOnly(d: Date | string | null): string {
  if (!d) return new Date().toISOString().slice(0, 10);
  const x = d instanceof Date ? d : new Date(d);
  return x.toISOString().slice(0, 10);
}

function buildSaleEntry(opts: {
  date: string;
  orderId: string;
  documentNumber: string | null;
  channelAccount: string;
  netCents: number;
  vatCents: number;
  currency: string;
}): JournalEntry {
  const lines = [
    {
      accountCode: opts.channelAccount,
      accountName: accountName(opts.channelAccount),
      debitCents: opts.netCents + opts.vatCents,
      creditCents: 0,
    },
    {
      accountCode: '4110',
      accountName: accountName('4110'),
      debitCents: 0,
      creditCents: opts.netCents,
    },
  ];
  if (opts.vatCents > 0) {
    lines.push({
      accountCode: '2201',
      accountName: accountName('2201'),
      debitCents: 0,
      creditCents: opts.vatCents,
    });
  }
  return JournalEntry.create({
    date: opts.date,
    description: `POS sale ${opts.documentNumber ?? opts.orderId.slice(0, 8)}`,
    reference: opts.documentNumber ?? null,
    sourceModule: 'pos',
    sourceId: opts.orderId,
    currency: opts.currency,
    lines,
  });
}

function buildRefundEntry(opts: {
  date: string;
  orderId: string;
  documentNumber: string | null;
  channelAccount: string;
  netCents: number;
  vatCents: number;
  currency: string;
}): JournalEntry {
  const lines = [
    {
      accountCode: '4140',
      accountName: accountName('4140'),
      debitCents: opts.netCents,
      creditCents: 0,
    },
  ];
  if (opts.vatCents > 0) {
    lines.push({
      accountCode: '2201',
      accountName: accountName('2201'),
      debitCents: opts.vatCents,
      creditCents: 0,
    });
  }
  lines.push({
    accountCode: opts.channelAccount,
    accountName: accountName(opts.channelAccount),
    debitCents: 0,
    creditCents: opts.netCents + opts.vatCents,
  });
  return JournalEntry.create({
    date: opts.date,
    description: `POS refund ${opts.documentNumber ?? opts.orderId.slice(0, 8)}`,
    reference: opts.documentNumber ?? null,
    sourceModule: 'pos',
    sourceId: opts.orderId,
    currency: opts.currency,
    lines,
  });
}

// Map kept here so the journal handler doesn't need to round-trip the
// CoA table just to label its lines. Names match the Thai SME seed.
const NAMES: Record<string, string> = {
  '1110': 'Cash on hand',
  '1120': 'Bank — checking',
  '1135': 'Card settlement in transit',
  '2201': 'Output VAT',
  '4110': 'Sales revenue — products',
  '4140': 'Sales returns',
};
function accountName(code: string): string {
  return NAMES[code] ?? code;
}
