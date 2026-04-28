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
