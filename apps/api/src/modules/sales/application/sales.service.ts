import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import { posOrders, partners, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

export interface ListSalesFilter {
  from?: string;       // ISO date
  to?: string;         // ISO date (exclusive upper bound)
  documentType?: 'RE' | 'ABB' | 'TX' | 'CN';
  status?: 'paid' | 'refunded' | 'voided' | 'draft';
  paymentMethod?: 'cash' | 'card' | 'promptpay' | 'split';
  buyerTin?: string;
  search?: string;     // matches buyer name / doc number
  limit?: number;
  offset?: number;
}

@Injectable()
export class SalesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listSales(opts: ListSalesFilter = {}) {
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const conds = [];
    if (opts.from) conds.push(gte(posOrders.createdAt, new Date(opts.from)));
    if (opts.to) conds.push(lt(posOrders.createdAt, new Date(opts.to)));
    if (opts.documentType) conds.push(eq(posOrders.documentType, opts.documentType));
    if (opts.status) conds.push(eq(posOrders.status, opts.status));
    if (opts.paymentMethod) conds.push(eq(posOrders.paymentMethod, opts.paymentMethod));
    if (opts.buyerTin) conds.push(eq(posOrders.buyerTin, opts.buyerTin));
    if (opts.search) {
      const q = `%${opts.search}%`;
      conds.push(
        or(
          ilike(posOrders.buyerName, q),
          ilike(posOrders.documentNumber, q),
          ilike(posOrders.buyerTin, q),
        )!,
      );
    }

    const where = conds.length > 0 ? and(...conds) : undefined;

    const [rows, [{ count }]] = await Promise.all([
      this.db
        .select({
          id: posOrders.id,
          documentType: posOrders.documentType,
          documentNumber: posOrders.documentNumber,
          status: posOrders.status,
          paymentMethod: posOrders.paymentMethod,
          totalCents: posOrders.totalCents,
          subtotalCents: posOrders.subtotalCents,
          taxCents: posOrders.taxCents,
          discountCents: posOrders.discountCents,
          currency: posOrders.currency,
          buyerName: posOrders.buyerName,
          buyerTin: posOrders.buyerTin,
          buyerBranch: posOrders.buyerBranch,
          orderLines: posOrders.orderLines,
          vatBreakdown: posOrders.vatBreakdown,
          originalOrderId: posOrders.originalOrderId,
          createdAt: posOrders.createdAt,
        })
        .from(posOrders)
        .where(where)
        .orderBy(desc(posOrders.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(posOrders)
        .where(where),
    ]);

    return { rows, total: Number(count), limit, offset };
  }

  async getSale(id: string) {
    const [row] = await this.db
      .select()
      .from(posOrders)
      .where(eq(posOrders.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Customer ledger: aggregates by buyer_tin (preferred) or buyer_name (fallback).
   * Includes only paid + refunded rows so the totals tie to PP.30.
   */
  async listCustomers(opts: { search?: string; limit?: number } = {}) {
    const limit = Math.min(opts.limit ?? 100, 500);
    const searchSql = opts.search
      ? sql`AND (
          ${posOrders.buyerName} ILIKE ${'%' + opts.search + '%'}
          OR ${posOrders.buyerTin} ILIKE ${'%' + opts.search + '%'}
        )`
      : sql``;

    const aggregated = await this.db.execute(sql`
      SELECT
        COALESCE(${posOrders.buyerTin}, '__no_tin__') AS tin,
        MAX(${posOrders.buyerName}) AS name,
        MAX(${posOrders.buyerBranch}) AS branch,
        COUNT(*) FILTER (WHERE ${posOrders.status} IN ('paid','refunded'))::int AS order_count,
        COALESCE(SUM(${posOrders.totalCents}) FILTER (WHERE ${posOrders.status} = 'paid'), 0)::bigint AS gross_cents,
        COALESCE(SUM(${posOrders.totalCents}) FILTER (WHERE ${posOrders.documentType} = 'CN'), 0)::bigint AS refund_cents,
        MAX(${posOrders.createdAt}) AS last_order_at,
        MIN(${posOrders.createdAt}) AS first_order_at
      FROM ${posOrders}
      WHERE ${posOrders.buyerName} IS NOT NULL
        AND ${posOrders.status} IN ('paid','refunded')
        ${searchSql}
      GROUP BY COALESCE(${posOrders.buyerTin}, '__no_tin__')
      ORDER BY gross_cents DESC NULLS LAST
      LIMIT ${limit}
    `);

    const rows = (aggregated as Array<Record<string, any>>).map((r) => ({
      tin: r.tin === '__no_tin__' ? null : r.tin,
      name: r.name,
      branch: r.branch,
      orderCount: Number(r.order_count),
      grossCents: Number(r.gross_cents),
      refundCents: Number(r.refund_cents),
      netCents: Number(r.gross_cents) + Number(r.refund_cents), // refund stored negative
      firstOrderAt: r.first_order_at,
      lastOrderAt: r.last_order_at,
    }));

    // Enrich with partners table info (email/phone) if a TIN match exists
    const tins = rows.map((r) => r.tin).filter((t): t is string => !!t);
    const partnerRows = tins.length
      ? await this.db
          .select({
            tin: partners.tin,
            email: partners.email,
            phone: partners.phone,
            paymentTermsDays: partners.paymentTermsDays,
            id: partners.id,
          })
          .from(partners)
          .where(and(eq(partners.isCustomer, true), inArray(partners.tin, tins)))
      : [];
    const byTin = new Map(partnerRows.map((p) => [p.tin!, p]));

    return rows.map((r) => ({
      ...r,
      partnerId: r.tin ? byTin.get(r.tin)?.id ?? null : null,
      email: r.tin ? byTin.get(r.tin)?.email ?? null : null,
      phone: r.tin ? byTin.get(r.tin)?.phone ?? null : null,
      paymentTermsDays: r.tin ? byTin.get(r.tin)?.paymentTermsDays ?? null : null,
    }));
  }

  /**
   * Daily sales summary for the chart in /sales analytics.
   * Returns one row per day in the requested window.
   */
  async dailySummary(opts: { from: string; to: string; tz?: string }) {
    const tz = opts.tz ?? 'Asia/Bangkok';
    const result = await this.db.execute(sql`
      SELECT
        to_char(date_trunc('day', ${posOrders.createdAt} AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day,
        COUNT(*) FILTER (WHERE ${posOrders.status} = 'paid')::int AS order_count,
        COUNT(*) FILTER (WHERE ${posOrders.documentType} = 'CN')::int AS refund_count,
        COALESCE(SUM(${posOrders.totalCents}) FILTER (WHERE ${posOrders.status} = 'paid' AND ${posOrders.documentType} <> 'CN'), 0)::bigint AS gross_cents,
        COALESCE(SUM(${posOrders.totalCents}) FILTER (WHERE ${posOrders.documentType} = 'CN'), 0)::bigint AS refund_cents,
        COALESCE(SUM(${posOrders.taxCents}) FILTER (WHERE ${posOrders.status} = 'paid' AND ${posOrders.documentType} <> 'CN'), 0)::bigint AS vat_cents
      FROM ${posOrders}
      WHERE ${posOrders.createdAt} >= ${opts.from}::timestamptz
        AND ${posOrders.createdAt} < ${opts.to}::timestamptz
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    return (result as Array<Record<string, any>>).map((r) => ({
      day: r.day,
      orderCount: Number(r.order_count),
      refundCount: Number(r.refund_count),
      grossCents: Number(r.gross_cents),
      refundCents: Number(r.refund_cents),
      netCents: Number(r.gross_cents) + Number(r.refund_cents),
      vatCents: Number(r.vat_cents),
    }));
  }

  /** Top products by revenue across the requested window. */
  async topProducts(opts: { from: string; to: string; limit?: number }) {
    const limit = Math.min(opts.limit ?? 10, 100);
    const result = await this.db.execute(sql`
      SELECT
        line ->> 'name' AS name,
        line ->> 'productId' AS product_id,
        SUM((line ->> 'qty')::numeric)::numeric AS qty,
        SUM(((line ->> 'qty')::numeric) * ((line ->> 'unitPriceCents')::bigint))::bigint AS revenue_cents
      FROM ${posOrders}, jsonb_array_elements(${posOrders.orderLines}) AS line
      WHERE ${posOrders.createdAt} >= ${opts.from}::timestamptz
        AND ${posOrders.createdAt} < ${opts.to}::timestamptz
        AND ${posOrders.status} = 'paid'
        AND ${posOrders.documentType} <> 'CN'
      GROUP BY 1, 2
      ORDER BY revenue_cents DESC NULLS LAST
      LIMIT ${limit}
    `);

    return (result as Array<Record<string, any>>).map((r) => ({
      productId: r.product_id,
      name: r.name,
      qty: Number(r.qty),
      revenueCents: Number(r.revenue_cents),
    }));
  }
}
