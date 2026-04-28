import { Inject, Injectable } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { and, eq, sql } from 'drizzle-orm';
import { posOrders, posSessions, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { SessionNotFoundError } from '../../domain/session-errors';

export class GetCurrentSessionQuery {
  constructor(public readonly userId: string) {}
}

export class GetSessionSummaryQuery {
  constructor(public readonly sessionId: string) {}
}

export class GetSessionsDashboardQuery {
  constructor() {}
}

@Injectable()
@QueryHandler(GetCurrentSessionQuery)
export class GetCurrentSessionHandler implements IQueryHandler<GetCurrentSessionQuery> {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async execute(q: GetCurrentSessionQuery) {
    const rows = await this.db
      .select()
      .from(posSessions)
      .where(and(eq(posSessions.userId, q.userId), eq(posSessions.status, 'open')))
      .limit(1);
    return rows[0] ?? null;
  }
}

@Injectable()
@QueryHandler(GetSessionSummaryQuery)
export class GetSessionSummaryHandler implements IQueryHandler<GetSessionSummaryQuery> {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async execute(q: GetSessionSummaryQuery) {
    const [session] = await this.db
      .select()
      .from(posSessions)
      .where(eq(posSessions.id, q.sessionId))
      .limit(1);
    if (!session) throw new SessionNotFoundError(q.sessionId);

    const byMethod = await this.db
      .select({
        method: posOrders.paymentMethod,
        orderCount: sql<number>`COUNT(*)::int`.as('orderCount'),
        totalCents: sql<number>`COALESCE(SUM(${posOrders.totalCents})::bigint, 0)`.as('totalCents'),
      })
      .from(posOrders)
      .where(and(eq(posOrders.sessionId, q.sessionId), eq(posOrders.status, 'paid')))
      .groupBy(posOrders.paymentMethod);

    const grandTotal = byMethod.reduce((sum, r) => sum + Number(r.totalCents), 0);

    return {
      session,
      salesByMethod: byMethod.map((r) => ({
        method: r.method,
        orderCount: r.orderCount,
        totalCents: Number(r.totalCents),
      })),
      grandTotalCents: grandTotal,
    };
  }
}

/**
 * Cheap aggregate for the home dashboard's status strip.
 * Returns:
 *   - openCount: how many sessions are currently open (status='open')
 *   - openCashCents: sum of (opening_balance + cash sales) for those sessions
 *   - oldestOpenAt: the earliest opened_at timestamp among open sessions, or null
 *   - staleHours: hours since the oldest open session was opened (0 if none)
 *
 * The 24h sweeper auto-marks abandoned, so anything still 'open' here is in
 * the active window. The caller maps `staleHours > 12` → yellow, ≥ 24 → red.
 */
@Injectable()
@QueryHandler(GetSessionsDashboardQuery)
export class GetSessionsDashboardHandler implements IQueryHandler<GetSessionsDashboardQuery> {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async execute(_q: GetSessionsDashboardQuery) {
    const open = await this.db
      .select()
      .from(posSessions)
      .where(eq(posSessions.status, 'open'));

    if (open.length === 0) {
      return { openCount: 0, openCashCents: 0, oldestOpenAt: null, staleHours: 0 };
    }

    const ids = open.map((s) => s.id);
    const cashByOrders = await this.db
      .select({
        sessionId: posOrders.sessionId,
        totalCents: sql<number>`COALESCE(SUM(${posOrders.totalCents})::bigint, 0)`.as('totalCents'),
      })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.paymentMethod, 'cash'),
          eq(posOrders.status, 'paid'),
          sql`${posOrders.sessionId} = ANY(${sql.raw(`ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]`)})`,
        ),
      )
      .groupBy(posOrders.sessionId);

    const cashBySession = new Map(cashByOrders.map((c) => [c.sessionId, Number(c.totalCents)]));
    let openCash = 0;
    for (const s of open) {
      openCash += Number(s.openingBalanceCents) + (cashBySession.get(s.id) ?? 0);
    }

    const oldest = open.reduce<Date | null>((min, s) => {
      const t = s.openedAt ? new Date(s.openedAt as any) : null;
      if (!t) return min;
      if (!min || t < min) return t;
      return min;
    }, null);

    const staleHours = oldest
      ? Math.floor((Date.now() - oldest.getTime()) / (60 * 60 * 1000))
      : 0;

    return {
      openCount: open.length,
      openCashCents: openCash,
      oldestOpenAt: oldest?.toISOString() ?? null,
      staleHours,
    };
  }
}
