import { Inject, Injectable, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { and, eq, sql } from 'drizzle-orm';
import { posOrders, posSessions, type Database } from '@erp/db';
import { DRIZZLE } from '../../../../shared/infrastructure/database/database.module';
import { OpenSessionCommand, CloseSessionCommand } from './session.commands';
import {
  SessionAlreadyOpenError,
  SessionNotFoundError,
  SessionAlreadyClosedError,
  VarianceRequiresApprovalError,
} from '../../domain/session-errors';

/** Variance larger than this (absolute cents) needs manager sign-off. */
const AUTO_ACCEPT_VARIANCE_CENTS = 500; // $5

@Injectable()
@CommandHandler(OpenSessionCommand)
export class OpenSessionHandler implements ICommandHandler<OpenSessionCommand> {
  private readonly logger = new Logger(OpenSessionHandler.name);
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async execute(cmd: OpenSessionCommand) {
    const existing = await this.db
      .select({ id: posSessions.id })
      .from(posSessions)
      .where(and(eq(posSessions.userId, cmd.userId), eq(posSessions.status, 'open')))
      .limit(1);

    if (existing.length > 0) {
      throw new SessionAlreadyOpenError(cmd.userId, existing[0].id);
    }

    const [row] = await this.db
      .insert(posSessions)
      .values({
        userId: cmd.userId,
        openingBalanceCents: cmd.openingBalanceCents,
        deviceId: cmd.deviceId ?? null,
        branchCode: cmd.branchCode ?? '00000',
        status: 'open',
      })
      .returning();

    this.logger.log(`Session opened: id=${row.id} user=${cmd.userId} float=${cmd.openingBalanceCents}c`);
    return row;
  }
}

@Injectable()
@CommandHandler(CloseSessionCommand)
export class CloseSessionHandler implements ICommandHandler<CloseSessionCommand> {
  private readonly logger = new Logger(CloseSessionHandler.name);
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async execute(cmd: CloseSessionCommand) {
    const [session] = await this.db
      .select()
      .from(posSessions)
      .where(eq(posSessions.id, cmd.sessionId))
      .limit(1);

    if (!session) throw new SessionNotFoundError(cmd.sessionId);
    if (session.status !== 'open') {
      throw new SessionAlreadyClosedError(cmd.sessionId, session.status);
    }

    // Compute expected cash: opening float + sum of cash-paid orders for this session.
    const [{ cashSales }] = await this.db
      .select({
        cashSales: sql<number>`COALESCE(SUM(${posOrders.totalCents})::bigint, 0)`.as('cashSales'),
      })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.sessionId, cmd.sessionId),
          eq(posOrders.paymentMethod, 'cash'),
          eq(posOrders.status, 'paid'),
        ),
      );

    const expected = session.openingBalanceCents + Number(cashSales);
    const variance = cmd.countedBalanceCents - expected;

    if (Math.abs(variance) > AUTO_ACCEPT_VARIANCE_CENTS && !cmd.varianceApprovedBy) {
      throw new VarianceRequiresApprovalError(variance, AUTO_ACCEPT_VARIANCE_CENTS);
    }

    const [updated] = await this.db
      .update(posSessions)
      .set({
        status: 'closed',
        closingBalanceCents: cmd.countedBalanceCents,
        expectedBalanceCents: expected,
        varianceCents: variance,
        varianceApprovedBy: cmd.varianceApprovedBy ?? null,
        closedAt: new Date(),
      })
      .where(eq(posSessions.id, cmd.sessionId))
      .returning();

    this.logger.log(
      `Session closed: id=${cmd.sessionId} expected=${expected}c counted=${cmd.countedBalanceCents}c variance=${variance}c`,
    );
    return updated;
  }
}
