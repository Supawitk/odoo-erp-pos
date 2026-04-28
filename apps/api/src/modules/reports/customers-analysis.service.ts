import { Inject, Injectable } from '@nestjs/common';
import { and, gte, lt } from 'drizzle-orm';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

export interface CustomerRow {
  key: string;            // TIN if known, else "walk-in"
  name: string;
  tin: string | null;
  orderCount: number;
  revenueCents: number;
  refundCents: number;
  netCents: number;
  firstSeenIso: string;
  lastSeenIso: string;
}

export interface CustomerConcentration {
  topCount: number;
  topRevenueCents: number;
  totalRevenueCents: number;
  share: number;          // 0..1
}

export interface CustomersAnalysis {
  fromIso: string;
  toIso: string;
  rows: CustomerRow[];
  totals: { customerCount: number; revenueCents: number };
  concentration: {
    top10: CustomerConcentration;
    top25: CustomerConcentration;
  };
}

@Injectable()
export class CustomersAnalysisService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { fromIso: string; toIso: string }): Promise<CustomersAnalysis> {
    const from = new Date(opts.fromIso);
    const to = new Date(opts.toIso);

    const rows = await this.db
      .select({
        createdAt: posOrders.createdAt,
        totalCents: posOrders.totalCents,
        documentType: posOrders.documentType,
        buyerName: posOrders.buyerName,
        buyerTin: posOrders.buyerTin,
      })
      .from(posOrders)
      .where(and(gte(posOrders.createdAt, from), lt(posOrders.createdAt, to)));

    const map = new Map<string, CustomerRow>();
    for (const r of rows) {
      const tin = r.buyerTin?.trim() || null;
      const name = r.buyerName?.trim() || 'Walk-in';
      const key = tin ?? `name:${name.toLowerCase()}`;
      const cur =
        map.get(key) ??
        ({
          key,
          name,
          tin,
          orderCount: 0,
          revenueCents: 0,
          refundCents: 0,
          netCents: 0,
          firstSeenIso: r.createdAt
            ? (r.createdAt as Date).toISOString()
            : new Date().toISOString(),
          lastSeenIso: r.createdAt
            ? (r.createdAt as Date).toISOString()
            : new Date().toISOString(),
        } as CustomerRow);

      const cents = Number(r.totalCents);
      cur.orderCount += 1;
      if (r.documentType === 'CN') {
        cur.refundCents += cents;
      } else {
        cur.revenueCents += cents;
      }
      cur.netCents = cur.revenueCents + cur.refundCents;

      const t = r.createdAt ? (r.createdAt as Date).toISOString() : cur.lastSeenIso;
      if (t < cur.firstSeenIso) cur.firstSeenIso = t;
      if (t > cur.lastSeenIso) cur.lastSeenIso = t;
      map.set(key, cur);
    }

    const list = [...map.values()].sort((a, b) => b.netCents - a.netCents);
    const totalRevenue = list.reduce((s, r) => s + r.netCents, 0);

    const top10Sum = list.slice(0, 10).reduce((s, r) => s + r.netCents, 0);
    const top25Sum = list.slice(0, 25).reduce((s, r) => s + r.netCents, 0);

    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      rows: list.slice(0, 100),
      totals: { customerCount: list.length, revenueCents: totalRevenue },
      concentration: {
        top10: {
          topCount: Math.min(10, list.length),
          topRevenueCents: top10Sum,
          totalRevenueCents: totalRevenue,
          share: totalRevenue === 0 ? 0 : top10Sum / totalRevenue,
        },
        top25: {
          topCount: Math.min(25, list.length),
          topRevenueCents: top25Sum,
          totalRevenueCents: totalRevenue,
          share: totalRevenue === 0 ? 0 : top25Sum / totalRevenue,
        },
      },
    };
  }
}
