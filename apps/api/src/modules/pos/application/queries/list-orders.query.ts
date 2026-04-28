import { Inject, Injectable } from '@nestjs/common';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { and, desc, eq } from 'drizzle-orm';
import { posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';

export class ListOrdersQuery {
  constructor(
    public readonly sessionId?: string,
    public readonly limit = 20,
  ) {}
}

@Injectable()
@QueryHandler(ListOrdersQuery)
export class ListOrdersHandler implements IQueryHandler<ListOrdersQuery> {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async execute(q: ListOrdersQuery) {
    const limit = Math.min(q.limit, 100);
    const where = q.sessionId ? eq(posOrders.sessionId, q.sessionId) : undefined;

    const rows = await this.db
      .select({
        id: posOrders.id,
        sessionId: posOrders.sessionId,
        totalCents: posOrders.totalCents,
        currency: posOrders.currency,
        paymentMethod: posOrders.paymentMethod,
        status: posOrders.status,
        orderLines: posOrders.orderLines,
        createdAt: posOrders.createdAt,
      })
      .from(posOrders)
      .where(where)
      .orderBy(desc(posOrders.createdAt))
      .limit(limit);

    return rows;
  }
}
