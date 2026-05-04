import { Inject, Injectable } from '@nestjs/common';
import { and, gte, lt, sql } from 'drizzle-orm';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * 🇹🇭 VAT mix per [from, to). Aggregates vat_breakdown.* across pos_orders so
 * the admin can see at a glance how much of the period's revenue was:
 *
 *   - taxable (7%)
 *   - zero-rated (export, etc.)
 *   - exempt
 *
 * CN rows are signed-negative in the DB so they self-net here. This is the
 * exact same source of truth PP.30 reads from — useful as a lightweight
 * proxy for "what VAT will I file at the end of the month".
 */

export interface VatMixReport {
  fromIso: string;
  toIso: string;
  taxableNetCents: number;
  zeroRatedNetCents: number;
  exemptNetCents: number;
  totalNetCents: number;
  vatCents: number;
  orderCount: number;
}

@Injectable()
export class VatMixService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { fromIso?: string; toIso?: string } = {}): Promise<VatMixReport> {
    const now = new Date();
    const to = opts.toIso ? new Date(opts.toIso) : now;
    const from = opts.fromIso
      ? new Date(opts.fromIso)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Single SQL: pull each jsonb key with COALESCE→0 and sum.
    const [row] = await this.db
      .select({
        taxable: sql<number>`
          COALESCE(SUM((${posOrders.vatBreakdown} ->> 'taxableNetCents')::bigint), 0)::bigint
        `,
        zero: sql<number>`
          COALESCE(SUM((${posOrders.vatBreakdown} ->> 'zeroRatedNetCents')::bigint), 0)::bigint
        `,
        exempt: sql<number>`
          COALESCE(SUM((${posOrders.vatBreakdown} ->> 'exemptNetCents')::bigint), 0)::bigint
        `,
        vat: sql<number>`
          COALESCE(SUM((${posOrders.vatBreakdown} ->> 'vatCents')::bigint), 0)::bigint
        `,
        orderCount: sql<number>`COUNT(*)::int`,
      })
      .from(posOrders)
      .where(
        and(
          gte(posOrders.createdAt, from),
          lt(posOrders.createdAt, to),
        ),
      );

    const taxable = Number(row?.taxable ?? 0);
    const zero = Number(row?.zero ?? 0);
    const exempt = Number(row?.exempt ?? 0);

    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      taxableNetCents: taxable,
      zeroRatedNetCents: zero,
      exemptNetCents: exempt,
      totalNetCents: taxable + zero + exempt,
      vatCents: Number(row?.vat ?? 0),
      orderCount: Number(row?.orderCount ?? 0),
    };
  }
}
