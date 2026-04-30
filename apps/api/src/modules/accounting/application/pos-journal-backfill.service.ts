import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, isNull, notExists, sql } from 'drizzle-orm';
import {
  journalEntries,
  posOrders,
  stockMoves,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { JournalRepository } from '../infrastructure/journal.repository';
import {
  buildCogsEntry,
  buildRefundEntry,
  buildSaleEntry,
  dateOnly,
  paymentToAccount,
  vatFromBreakdown,
} from '../domain/pos-journal-builders';

/**
 * Replays missing journal entries for POS orders that pre-date the live event
 * handlers, surfaced by the PP.30 ↔ GL reconciliation tool.
 *
 * Two passes, both idempotent (UNIQUE skip via JournalRepository.findBySource):
 *   1. Sales / refund side  (sourceModule='pos'):
 *      For every paid|refunded pos_order without a matching journal,
 *      build the same Dr cash/Cr revenue/Cr VAT entry the live handler builds.
 *
 *   2. COGS side (sourceModule='pos-cogs'):
 *      For every order that already has stock_moves but no COGS journal,
 *      aggregate cost from stock_moves (Σ |qty| × unit_cost_cents) and post
 *      Dr 5100 / Cr 1161 (or the reverse for refunds).
 *
 * Returns a structured report. Failures are collected, not thrown — the caller
 * (admin endpoint) decides what to do with partial results.
 */
export interface BackfillReport {
  sales: {
    candidateCount: number;
    posted: number;
    skipped: number;
    failed: Array<{ orderId: string; reason: string }>;
  };
  cogs: {
    candidateCount: number;
    posted: number;
    skipped: number;
    failed: Array<{ orderId: string; reason: string }>;
  };
  durationMs: number;
}

@Injectable()
export class PosJournalBackfillService {
  private readonly logger = new Logger(PosJournalBackfillService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly journals: JournalRepository,
  ) {}

  async run(opts: { dryRun?: boolean } = {}): Promise<BackfillReport> {
    const start = Date.now();
    const dryRun = opts.dryRun ?? false;

    const sales = await this.backfillSales(dryRun);
    const cogs = await this.backfillCogs(dryRun);

    const report: BackfillReport = {
      sales,
      cogs,
      durationMs: Date.now() - start,
    };
    this.logger.log(
      `Backfill ${dryRun ? '(dry-run) ' : ''}done in ${report.durationMs}ms — ` +
        `sales: ${sales.posted}/${sales.candidateCount} posted, ` +
        `cogs: ${cogs.posted}/${cogs.candidateCount} posted, ` +
        `${sales.failed.length + cogs.failed.length} failures`,
    );
    return report;
  }

  // ─── Sales side ──────────────────────────────────────────────────────────
  private async backfillSales(dryRun: boolean): Promise<BackfillReport['sales']> {
    // Candidates: paid or refunded pos_orders missing a 'pos' journal.
    // We anchor on createdAt asc so backfilled entries get monotonic
    // entry_numbers in business-time order.
    const candidates = await this.db
      .select({
        id: posOrders.id,
        documentType: posOrders.documentType,
        documentNumber: posOrders.documentNumber,
        createdAt: posOrders.createdAt,
        totalCents: posOrders.totalCents,
        paymentMethod: posOrders.paymentMethod,
        currency: posOrders.currency,
        vatBreakdown: posOrders.vatBreakdown,
      })
      .from(posOrders)
      .where(
        and(
          sql`${posOrders.status} IN ('paid','refunded')`,
          notExists(
            this.db
              .select({ id: journalEntries.id })
              .from(journalEntries)
              .where(
                and(
                  eq(journalEntries.sourceModule, 'pos'),
                  eq(
                    journalEntries.sourceId,
                    sql`${posOrders.id}::text`,
                  ),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(posOrders.createdAt));

    let posted = 0;
    let skipped = 0;
    const failed: Array<{ orderId: string; reason: string }> = [];

    for (const o of candidates) {
      try {
        // Defensive: re-check via the repository in case a parallel handler
        // posted while the candidate list was being processed.
        if (await this.journals.findBySource('pos', o.id)) {
          skipped += 1;
          continue;
        }

        const total = Number(o.totalCents);
        if (!Number.isFinite(total) || total === 0) {
          failed.push({ orderId: o.id, reason: 'order has zero total' });
          continue;
        }

        const vat = vatFromBreakdown(o.vatBreakdown);
        const net = total - vat;
        const isRefund = o.documentType === 'CN';
        const channelAccount = paymentToAccount(o.paymentMethod);
        const date = dateOnly(o.createdAt as Date | string | null);

        const entry = isRefund
          ? buildRefundEntry({
              date,
              orderId: o.id,
              documentNumber: o.documentNumber,
              channelAccount,
              netCents: Math.abs(net),
              vatCents: Math.abs(vat),
              currency: o.currency,
            })
          : buildSaleEntry({
              date,
              orderId: o.id,
              documentNumber: o.documentNumber,
              channelAccount,
              netCents: net,
              vatCents: vat,
              currency: o.currency,
            });

        if (!dryRun) {
          await this.journals.insert(entry, { autoPost: true });
        }
        posted += 1;
      } catch (e: any) {
        failed.push({ orderId: o.id, reason: e?.message ?? String(e) });
      }
    }

    return { candidateCount: candidates.length, posted, skipped, failed };
  }

  // ─── COGS side ───────────────────────────────────────────────────────────
  private async backfillCogs(dryRun: boolean): Promise<BackfillReport['cogs']> {
    // Candidates: order ids that have stock_moves with source_module='pos'
    // and DON'T already have a 'pos-cogs' journal entry.
    //
    // Source-id format is composite (`{orderId}:{productId}`) so we split on
    // the colon and aggregate per orderId. Cost is taken from
    // stock_moves.unit_cost_cents when present (Phase 4 batch 2 onward) and
    // falls back to products.avg_cost_cents otherwise — historical orders
    // pre-date the snapshot and we accept a small drift for the backfill.
    const rows = await this.db.execute<{
      order_id: string;
      cost_cents: string;
      is_refund: boolean;
      currency: string;
      created_at: string | null;
      had_fallback: boolean;
    }>(sql`
      WITH parsed AS (
        SELECT
          split_part(sm.source_id, ':', 1)::uuid AS order_id,
          sm.qty,
          COALESCE(sm.unit_cost_cents, p.avg_cost_cents, 0) AS unit_cost,
          (sm.unit_cost_cents IS NULL) AS used_fallback
        FROM custom.stock_moves sm
        LEFT JOIN custom.products p ON p.id = sm.product_id
        WHERE sm.source_module = 'pos'
          AND sm.source_id IS NOT NULL
      )
      SELECT
        parsed.order_id,
        SUM(ABS(parsed.qty * parsed.unit_cost)) AS cost_cents,
        BOOL_OR(po.document_type = 'CN') AS is_refund,
        MAX(po.currency) AS currency,
        MIN(po.created_at)::text AS created_at,
        BOOL_OR(parsed.used_fallback) AS had_fallback
      FROM parsed
      INNER JOIN custom.pos_orders po ON po.id = parsed.order_id
      WHERE NOT EXISTS (
        SELECT 1 FROM custom.journal_entries je
        WHERE je.source_module = 'pos-cogs'
          AND je.source_id = parsed.order_id::text
      )
      GROUP BY parsed.order_id
      HAVING SUM(ABS(parsed.qty * parsed.unit_cost)) > 0
      ORDER BY MIN(po.created_at) ASC
    `);

    const candidates = (rows as any).rows ?? (rows as any) ?? [];
    let posted = 0;
    let skipped = 0;
    const failed: Array<{ orderId: string; reason: string }> = [];

    for (const r of candidates as Array<{
      order_id: string;
      cost_cents: string;
      is_refund: boolean;
      currency: string;
      created_at: string | null;
      had_fallback: boolean;
    }>) {
      try {
        if (await this.journals.findBySource('pos-cogs', r.order_id)) {
          skipped += 1;
          continue;
        }
        const cost = Math.round(Number(r.cost_cents));
        if (cost <= 0) {
          failed.push({ orderId: r.order_id, reason: 'aggregated cost is zero' });
          continue;
        }
        const entry = buildCogsEntry({
          date: dateOnly(r.created_at),
          orderId: r.order_id,
          totalCostCents: cost,
          isRefund: !!r.is_refund,
          currency: r.currency || 'THB',
        });
        if (!dryRun) {
          await this.journals.insert(entry, { autoPost: true });
        }
        posted += 1;
      } catch (e: any) {
        failed.push({ orderId: r.order_id, reason: e?.message ?? String(e) });
      }
    }

    return { candidateCount: (candidates as any).length, posted, skipped, failed };
  }
}
