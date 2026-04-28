import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  cycleCountLines,
  cycleCountSessions,
  products,
  stockQuants,
  warehouses,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { StockService } from './stock.service';
import { VarianceRequiresApprovalError, WarehouseNotFoundError } from '../domain/errors';

/**
 * Cycle counts: warehouse staff blind-count a subset, then reconcile to expected.
 *
 * Variance auto-accept policy (mirrors POS session-close pattern):
 *   - |variance_cents| ≤ ฿100 (10000 satang)  OR
 *   - |variance_qty / expected_qty| ≤ 2%
 *   → auto-accept; post adjustment with approvedBy='SYSTEM:CC-AUTO'
 * Otherwise the session sits in `reconciling` until a manager calls post()
 * with their userId in approvedBy.
 *
 * State machine: open → counting → reconciling → posted
 *                                            └─→ cancelled
 */
const VARIANCE_AUTO_THRESHOLD_CENTS = 10000; // ฿100
const VARIANCE_AUTO_THRESHOLD_FRAC = 0.02; // 2%

export interface OpenCycleCountInput {
  warehouseId?: string; // defaults to MAIN
  counterUserId: string;
  notes?: string;
}

export interface SubmitCountInput {
  sessionId: string;
  lines: { productId: string; countedQty: number }[];
}

export interface PostCycleCountInput {
  sessionId: string;
  approvedBy?: string; // required when any line breaches auto-accept thresholds
}

@Injectable()
export class CycleCountService {
  private readonly logger = new Logger(CycleCountService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly stock: StockService,
  ) {}

  /**
   * 1. open() — snapshot expected qty per product for this warehouse.
   * Captured at session-open time so concurrent sales during counting don't
   * shift the comparison baseline.
   */
  async open(input: OpenCycleCountInput): Promise<{ sessionId: string; lineCount: number }> {
    const warehouseId = input.warehouseId ?? (await this.stock.resolveMainWarehouse());
    const [wh] = await this.db
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId))
      .limit(1);
    if (!wh) throw new WarehouseNotFoundError(warehouseId);

    return this.db.transaction(async (tx) => {
      const sessionId = uuidv7();
      await tx.insert(cycleCountSessions).values({
        id: sessionId,
        warehouseId,
        counterUserId: input.counterUserId,
        status: 'open',
        notes: input.notes ?? null,
      });

      // Snapshot expected qty for every product with stock OR a quant row at this warehouse.
      const expected = await tx
        .select({
          productId: stockQuants.productId,
          qtyOnHand: stockQuants.qtyOnHand,
        })
        .from(stockQuants)
        .where(eq(stockQuants.warehouseId, warehouseId));

      if (expected.length > 0) {
        await tx.insert(cycleCountLines).values(
          expected.map((e) => ({
            id: uuidv7(),
            sessionId,
            productId: e.productId,
            expectedQty: e.qtyOnHand,
            countedQty: null,
            varianceQty: null,
            varianceValueCents: null,
            autoAccepted: false,
          })),
        );
      }

      this.logger.log(`Cycle count ${sessionId} open at ${wh.code} — ${expected.length} lines`);
      return { sessionId, lineCount: expected.length };
    });
  }

  /**
   * 2. submitCount() — staff enters the blind count. Computes variance per line
   * and decides auto-accept eligibility. Session moves to `reconciling`.
   */
  async submitCount(input: SubmitCountInput): Promise<{
    sessionId: string;
    breaches: number;
    autoAcceptable: number;
    totalVarianceCents: number;
  }> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(cycleCountSessions)
        .where(eq(cycleCountSessions.id, input.sessionId))
        .limit(1);
      if (!session) throw new Error(`Cycle count ${input.sessionId} not found`);
      if (session.status !== 'open' && session.status !== 'counting') {
        throw new Error(`Cycle count ${input.sessionId} is ${session.status}, cannot submit`);
      }

      const lineMap = new Map(input.lines.map((l) => [l.productId, l.countedQty]));
      const dbLines = await tx
        .select({
          id: cycleCountLines.id,
          productId: cycleCountLines.productId,
          expectedQty: cycleCountLines.expectedQty,
          avgCostCents: stockQuants.avgCostCents,
        })
        .from(cycleCountLines)
        .innerJoin(
          stockQuants,
          and(
            eq(stockQuants.productId, cycleCountLines.productId),
            eq(stockQuants.warehouseId, session.warehouseId),
          ),
        )
        .where(eq(cycleCountLines.sessionId, input.sessionId));

      let breaches = 0;
      let autoAcceptable = 0;
      let totalVarianceCents = 0;

      for (const dbLine of dbLines) {
        const counted = lineMap.get(dbLine.productId);
        if (counted == null) continue; // not counted this round
        const expected = Number(dbLine.expectedQty);
        const variance = counted - expected;
        const avgCost = dbLine.avgCostCents != null ? Number(dbLine.avgCostCents) : 0;
        const varianceValueCents = Math.round(variance * avgCost);

        const fracBreached =
          expected !== 0 && Math.abs(variance / expected) > VARIANCE_AUTO_THRESHOLD_FRAC;
        const cashBreached = Math.abs(varianceValueCents) > VARIANCE_AUTO_THRESHOLD_CENTS;
        const autoAccept = !fracBreached && !cashBreached;

        await tx
          .update(cycleCountLines)
          .set({
            countedQty: String(counted),
            varianceQty: String(variance),
            varianceValueCents,
            autoAccepted: autoAccept,
          })
          .where(eq(cycleCountLines.id, dbLine.id));

        totalVarianceCents += varianceValueCents;
        if (autoAccept) autoAcceptable += 1;
        else breaches += 1;
      }

      await tx
        .update(cycleCountSessions)
        .set({
          status: 'reconciling',
          blindCountAt: new Date(),
          varianceTotalCents: totalVarianceCents,
        })
        .where(eq(cycleCountSessions.id, input.sessionId));

      this.logger.log(
        `Cycle count ${input.sessionId} counted: ${autoAcceptable} auto-accepted, ${breaches} breaches, total variance ${totalVarianceCents} satang`,
      );

      return { sessionId: input.sessionId, breaches, autoAcceptable, totalVarianceCents };
    });
  }

  /**
   * 3. post() — for each non-zero-variance line:
   *    - if autoAccepted → apply with approvedBy='SYSTEM:CC-AUTO'
   *    - else → require approvedBy in input; apply with approvedBy=that user
   *
   * Each line generates a `cycle_count_adjust` stock_move. Session goes to `posted`.
   */
  async post(input: PostCycleCountInput): Promise<{
    sessionId: string;
    movesCreated: number;
    requiresApproval: boolean;
  }> {
    const [session] = await this.db
      .select()
      .from(cycleCountSessions)
      .where(eq(cycleCountSessions.id, input.sessionId))
      .limit(1);
    if (!session) throw new Error(`Cycle count ${input.sessionId} not found`);
    if (session.status !== 'reconciling') {
      throw new Error(
        `Cycle count ${input.sessionId} is ${session.status}, must be reconciling to post`,
      );
    }

    const lines = await this.db
      .select()
      .from(cycleCountLines)
      .where(eq(cycleCountLines.sessionId, input.sessionId));

    const breaches = lines.filter(
      (l) => l.countedQty != null && !l.autoAccepted && Number(l.varianceQty ?? 0) !== 0,
    );
    if (breaches.length > 0 && !input.approvedBy) {
      throw new VarianceRequiresApprovalError(
        Number(session.varianceTotalCents ?? 0),
        VARIANCE_AUTO_THRESHOLD_CENTS,
      );
    }

    let movesCreated = 0;
    for (const line of lines) {
      if (line.countedQty == null) continue;
      const variance = Number(line.varianceQty ?? 0);
      if (variance === 0) continue;

      const approver = line.autoAccepted ? 'SYSTEM:CC-AUTO' : input.approvedBy!;
      await this.stock.applyMove({
        productId: line.productId,
        qty: variance,
        moveType: 'cycle_count_adjust',
        fromWarehouseId: session.warehouseId,
        toWarehouseId: session.warehouseId,
        sourceModule: 'cycle_count',
        sourceId: `${session.id}:${line.productId}`,
        reference: `CC-${session.id.slice(0, 8)}`,
        performedBy: session.counterUserId,
        approvedBy: approver,
        reason: line.autoAccepted ? 'auto_accept' : 'manager_override',
      });
      movesCreated += 1;
    }

    await this.db
      .update(cycleCountSessions)
      .set({
        status: 'posted',
        postedAt: new Date(),
        approvedBy: input.approvedBy ?? null,
      })
      .where(eq(cycleCountSessions.id, input.sessionId));

    this.logger.log(
      `Cycle count ${input.sessionId} posted — ${movesCreated} adjustments by ${input.approvedBy ?? 'SYSTEM'}`,
    );

    return { sessionId: input.sessionId, movesCreated, requiresApproval: breaches.length > 0 };
  }

  async cancel(sessionId: string, reason?: string): Promise<void> {
    await this.db
      .update(cycleCountSessions)
      .set({ status: 'cancelled', notes: reason ?? null })
      .where(eq(cycleCountSessions.id, sessionId));
    this.logger.log(`Cycle count ${sessionId} cancelled: ${reason ?? '(no reason)'}`);
  }

  async getSession(sessionId: string) {
    const [session] = await this.db
      .select()
      .from(cycleCountSessions)
      .where(eq(cycleCountSessions.id, sessionId))
      .limit(1);
    if (!session) return null;
    const lines = await this.db
      .select({
        id: cycleCountLines.id,
        productId: cycleCountLines.productId,
        productName: products.name,
        expectedQty: cycleCountLines.expectedQty,
        countedQty: cycleCountLines.countedQty,
        varianceQty: cycleCountLines.varianceQty,
        varianceValueCents: cycleCountLines.varianceValueCents,
        autoAccepted: cycleCountLines.autoAccepted,
      })
      .from(cycleCountLines)
      .leftJoin(products, eq(products.id, cycleCountLines.productId))
      .where(eq(cycleCountLines.sessionId, sessionId))
      .orderBy(products.name);
    return { session, lines };
  }
}
