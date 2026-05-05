import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lte, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { odooOutbox, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

/**
 * Transactional outbox writer.
 *
 * Pattern: when a domain change happens (POS sale → stock_move, GRN post →
 * stock_move + cost_layer), we ALSO write a row to `custom.odoo_outbox` in the
 * SAME tx. A relay (BullMQ-driven) then drains rows to Odoo via JSON-RPC,
 * using `external_id` (ir.model.data xmlid) for idempotency: re-running a job
 * never duplicates because Odoo upserts by xmlid.
 *
 * For Phase 3 the writer also accepts already-committed events (the
 * StockMovedEvent listener path) — same UNIQUE on external_id keeps replays safe.
 */
export interface OutboxRow {
  id: string;
  model: string;
  operation: 'create' | 'write' | 'unlink';
  payload: Record<string, unknown>;
  externalId: string;
  status: 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'dlq';
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  odooId: number | null;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Enqueue an outbox row. UNIQUE on external_id makes this idempotent —
   * duplicate enqueues are silently swallowed.
   */
  async enqueue(input: {
    model: string;
    operation: 'create' | 'write' | 'unlink';
    payload: Record<string, unknown>;
    externalId: string;
  }): Promise<{ id: string; alreadyEnqueued: boolean }> {
    const id = uuidv7();
    try {
      await this.db.insert(odooOutbox).values({
        id,
        model: input.model,
        operation: input.operation,
        payload: input.payload as any,
        externalId: input.externalId,
      });
      return { id, alreadyEnqueued: false };
    } catch (err: any) {
      if (err?.code === '23505') {
        this.logger.warn(`Outbox duplicate enqueue (external_id=${input.externalId})`);
        return { id, alreadyEnqueued: true };
      }
      throw err;
    }
  }

  /**
   * Pull a batch of due outbox rows + flip them to in_flight in one tx with
   * SKIP LOCKED so multiple relay workers don't fight over the same row.
   */
  async claimDue(batchSize = 50): Promise<OutboxRow[]> {
    const rows = await this.db.execute<{
      id: string;
      model: string;
      operation: string;
      payload: any;
      external_id: string;
      attempts: number;
      next_attempt_at: Date;
    }>(sql`
      WITH due AS (
        SELECT id FROM custom.odoo_outbox
         WHERE status = 'pending'
           AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at
         LIMIT ${batchSize}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE custom.odoo_outbox SET status = 'in_flight', updated_at = NOW()
        WHERE id IN (SELECT id FROM due)
      RETURNING id, model, operation, payload, external_id, attempts, next_attempt_at
    `);

    return ((rows as any).rows ?? (rows as any)).map((r: any) => ({
      id: r.id,
      model: r.model,
      operation: r.operation,
      payload: r.payload,
      externalId: r.external_id,
      status: 'in_flight' as const,
      attempts: Number(r.attempts),
      nextAttemptAt: r.next_attempt_at,
      lastError: null,
      odooId: null,
    }));
  }

  async markSucceeded(id: string, odooId: number): Promise<void> {
    await this.db
      .update(odooOutbox)
      .set({
        status: 'succeeded',
        odooId,
        updatedAt: new Date(),
      })
      .where(eq(odooOutbox.id, id));
  }

  /**
   * Mark a row failed and schedule retry. After N attempts → dead-letter ('dlq').
   */
  async markFailed(id: string, errMessage: string, attempt: number): Promise<void> {
    const MAX_ATTEMPTS = 5;
    const nextStatus = attempt >= MAX_ATTEMPTS ? 'dlq' : 'pending';
    // Exponential backoff: 30s, 5m, 30m, 2h, 6h
    const backoffSec = [30, 300, 1800, 7200, 21600][Math.min(attempt - 1, 4)];
    const nextAttempt = new Date(Date.now() + backoffSec * 1000);
    await this.db
      .update(odooOutbox)
      .set({
        status: nextStatus,
        attempts: attempt,
        lastError: errMessage.slice(0, 1000),
        nextAttemptAt: nextAttempt,
        updatedAt: new Date(),
      })
      .where(eq(odooOutbox.id, id));
    if (nextStatus === 'dlq') {
      this.logger.error(`Outbox row ${id} → dlq after ${attempt} attempts: ${errMessage}`);
    } else {
      this.logger.warn(
        `Outbox row ${id} retry #${attempt} in ${backoffSec}s: ${errMessage}`,
      );
    }
  }

  async stats(): Promise<{
    pending: number;
    inFlight: number;
    succeeded: number;
    failed: number;
    dlq: number;
  }> {
    const rows = await this.db.execute<{ status: string; count: string }>(sql`
      SELECT status, COUNT(*)::text AS count
        FROM custom.odoo_outbox
       GROUP BY status
    `);
    const counts: Record<string, number> = { pending: 0, in_flight: 0, succeeded: 0, failed: 0, dlq: 0 };
    for (const r of (rows as any).rows ?? (rows as any)) {
      counts[r.status] = Number(r.count);
    }
    return {
      pending: counts.pending,
      inFlight: counts.in_flight,
      succeeded: counts.succeeded,
      failed: counts.failed,
      dlq: counts.dlq,
    };
  }

  /**
   * Diagnostics: classify pending rows by whether they could be pushed right
   * now if the relay ran. The relay's resolver throws `MAPPING_NOT_READY` when
   * a referenced product doesn't have `odoo_product_id` populated yet — this
   * function counts those without actually triggering the relay, so an admin
   * can see "X pending; Y of them are blocked on catalog mapping" without
   * burning retry attempts.
   *
   * Counts are best-effort: it walks `payload.product_id.external_ref` (the
   * shape the stock_move handler emits) and skips any row whose payload doesn't
   * follow that exact shape.
   */
  async diagnostics(): Promise<{
    pending: number;
    readyToPush: number;
    blockedOnMapping: number;
    unrecognisedShape: number;
    sampleBlocked: Array<{ id: string; productId: string; createdAt: string }>;
  }> {
    const pendingRows = await this.db.execute<{
      id: string;
      payload: any;
      created_at: string;
    }>(sql`
      SELECT id, payload, created_at::text
      FROM custom.odoo_outbox
      WHERE status = 'pending' AND model = 'stock.move'
      ORDER BY created_at
    `);
    const rows: any[] = (pendingRows as any).rows ?? (pendingRows as any) ?? [];

    let readyToPush = 0;
    let blockedOnMapping = 0;
    let unrecognisedShape = 0;
    const sampleBlocked: Array<{ id: string; productId: string; createdAt: string }> = [];

    for (const r of rows) {
      const ref = r.payload?.product_id?.external_ref;
      if (typeof ref !== 'string') {
        unrecognisedShape += 1;
        continue;
      }
      const lookup = await this.db.execute<{ odoo_product_id: number | null }>(sql`
        SELECT odoo_product_id FROM custom.products WHERE id::text = ${ref} LIMIT 1
      `);
      const lookupRows: any[] = (lookup as any).rows ?? (lookup as any) ?? [];
      const odooId = lookupRows[0]?.odoo_product_id;
      if (odooId) {
        readyToPush += 1;
      } else {
        blockedOnMapping += 1;
        if (sampleBlocked.length < 5) {
          sampleBlocked.push({
            id: r.id,
            productId: ref,
            createdAt: r.created_at,
          });
        }
      }
    }

    return {
      pending: rows.length,
      readyToPush,
      blockedOnMapping,
      unrecognisedShape,
      sampleBlocked,
    };
  }
}
