import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, eq } from 'drizzle-orm';
import { etaxSubmissions, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { LeceiptAdapter } from '../adapters/leceipt.adapter';
import { InetAdapter } from '../adapters/inet.adapter';
import type { EtaxSubmissionInput } from '../dtos/leceipt-response.dto';

/**
 * 🇹🇭 e-Tax submission relay (Phase 4B Stage 2).
 *
 * Drains pending rows from `custom.etax_submissions` and ships them to the
 * configured ASP. Triggered by BullMQ Job Scheduler v5 (`etax-relay`, every
 * minute, Asia/Bangkok). Multi-pod-safe via FOR UPDATE SKIP LOCKED.
 *
 * Status lifecycle inside the relay:
 *   pending           — waiting to be picked up
 *   submitted         — claimed (in-flight); set just before adapter call
 *   acknowledged      — terminal success (RD ack received)
 *   rejected          — terminal failure (ASP/RD rejected as malformed/invalid)
 *   pending (again)   — transient error → exponential backoff
 *   dlq               — exceeded MAX_ATTEMPTS retries; manual intervention needed
 *
 * Backoff: 30s → 5m → 30m → 2h → 6h. After attempt 5 → DLQ.
 *
 * Adapter selection: each row carries its own `provider` column ('leceipt' or
 * 'inet') chosen at queue-time. The relay routes to the right adapter; the row
 * never silently switches providers. To re-attempt with a different ASP, an
 * operator submits the order again with `?provider=…` which creates a fresh
 * row.
 */
const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [30, 300, 1800, 7200, 21600] as const;

export interface RelayRunResult {
  attempted: number;
  succeeded: number;
  failed: number;
  rejected: number;
  skipped: number;
}

@Injectable()
export class EtaxRelayService {
  private readonly logger = new Logger(EtaxRelayService.name);
  private running = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly leceipt: LeceiptAdapter,
    private readonly inet: InetAdapter,
  ) {}

  /**
   * Drain up to `batchSize` rows. Idempotent: a second invocation while the
   * first is mid-flight short-circuits (running flag).
   */
  async run(batchSize = 25): Promise<RelayRunResult> {
    if (this.running) {
      this.logger.debug('etax-relay skipping — previous tick still in flight');
      return { attempted: 0, succeeded: 0, failed: 0, rejected: 0, skipped: 0 };
    }
    this.running = true;
    try {
      return await this._drain(batchSize);
    } finally {
      this.running = false;
    }
  }

  private async _drain(batchSize: number): Promise<RelayRunResult> {
    const rows = await this.claimDue(batchSize);
    if (rows.length === 0) {
      return { attempted: 0, succeeded: 0, failed: 0, rejected: 0, skipped: 0 };
    }

    let succeeded = 0;
    let failed = 0;
    let rejected = 0;

    for (const row of rows) {
      try {
        const adapter = row.provider === 'inet' ? this.inet : this.leceipt;
        const input: EtaxSubmissionInput = {
          documentNumber: row.documentNumber,
          documentType: row.documentType as 'RE' | 'ABB' | 'TX' | 'CN' | 'DN',
          etdaCode: row.etdaCode as 'T01' | 'T02' | 'T03' | 'T04' | 'T05',
          xml: row.xmlPayload,
          xmlHash: row.xmlHash,
        };
        const result = await adapter.submit(input);

        if (result.status === 'success') {
          await this.markAcknowledged(row.id, result);
          succeeded += 1;
        } else if (result.status === 'rejected') {
          await this.markRejected(row.id, result.message ?? 'rejected by ASP', result.raw);
          rejected += 1;
        } else if (result.status === 'pending') {
          // ASP accepted but RD ack still pending — leave row in 'submitted'
          // and re-poll on the next tick. We set a short backoff (30s) so the
          // poller catches up quickly but doesn't spin tightly.
          await this.markSubmittedPending(row.id, result);
          // Counts as success for this tick (no retry budget burned).
          succeeded += 1;
        } else {
          // status === 'error' → transient or permanent
          await this.markFailed(row.id, result.message ?? 'unknown error', row.attempts + 1, result.retryable ?? true);
          failed += 1;
        }
      } catch (err: any) {
        const msg = (err?.message ?? String(err)).slice(0, 1000);
        await this.markFailed(row.id, msg, row.attempts + 1, true);
        failed += 1;
      }
    }

    this.logger.log(
      `etax-relay drain: ${rows.length} attempted | ${succeeded} ok | ${rejected} rejected | ${failed} retrying`,
    );
    return { attempted: rows.length, succeeded, failed, rejected, skipped: 0 };
  }

  /**
   * Atomic claim — flip `pending` due rows to `submitted` (in-flight) under
   * row locks so a second relay pod can't pick the same rows. After attempt
   * the status moves on to acknowledged/rejected/back-to-pending/dlq.
   */
  private async claimDue(batchSize: number): Promise<
    Array<{
      id: string;
      orderId: string;
      provider: string;
      documentType: string;
      documentNumber: string;
      etdaCode: string;
      xmlPayload: string;
      xmlHash: string;
      attempts: number;
    }>
  > {
    const rows = await this.db.execute(sql`
      WITH due AS (
        SELECT id FROM custom.etax_submissions
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY COALESCE(next_attempt_at, created_at)
         LIMIT ${batchSize}
         FOR UPDATE SKIP LOCKED
      )
      UPDATE custom.etax_submissions
         SET status = 'submitted', updated_at = NOW()
       WHERE id IN (SELECT id FROM due)
      RETURNING id, order_id, provider, document_type, document_number,
                etda_code, xml_payload, xml_hash, attempts
    `);
    const flat = ((rows as any).rows ?? rows) as Array<Record<string, any>>;
    return flat.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      provider: r.provider,
      documentType: r.document_type,
      documentNumber: r.document_number,
      etdaCode: r.etda_code,
      xmlPayload: r.xml_payload,
      xmlHash: r.xml_hash,
      attempts: Number(r.attempts ?? 0),
    }));
  }

  private async markAcknowledged(id: string, result: { rdReference?: string; providerReference?: string; ackTimestamp?: Date; raw?: unknown }) {
    await this.db
      .update(etaxSubmissions)
      .set({
        status: 'acknowledged',
        rdReference: result.rdReference ?? null,
        providerReference: result.providerReference ?? null,
        ackTimestamp: result.ackTimestamp ?? new Date(),
        providerResponse: (result.raw ?? null) as any,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(etaxSubmissions.id, id));
  }

  private async markRejected(id: string, message: string, raw?: unknown) {
    await this.db
      .update(etaxSubmissions)
      .set({
        status: 'rejected',
        lastError: message.slice(0, 1000),
        providerResponse: (raw ?? null) as any,
        updatedAt: new Date(),
      })
      .where(eq(etaxSubmissions.id, id));
    this.logger.error(`etax submission ${id} rejected: ${message}`);
  }

  private async markSubmittedPending(id: string, result: { providerReference?: string; raw?: unknown }) {
    // ASP accepted but no terminal status yet. Re-poll in 30s.
    const next = new Date(Date.now() + 30 * 1000);
    await this.db
      .update(etaxSubmissions)
      .set({
        status: 'pending',
        providerReference: result.providerReference ?? null,
        providerResponse: (result.raw ?? null) as any,
        nextAttemptAt: next,
        lastError: 'pending RD ack',
        updatedAt: new Date(),
      })
      .where(eq(etaxSubmissions.id, id));
  }

  private async markFailed(id: string, errMessage: string, attempt: number, retryable: boolean) {
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      await this.db
        .update(etaxSubmissions)
        .set({
          status: 'dlq',
          attempts: attempt,
          lastError: errMessage.slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(eq(etaxSubmissions.id, id));
      this.logger.error(`etax submission ${id} → dlq after ${attempt} attempts: ${errMessage}`);
      return;
    }
    const backoffSec = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];
    const next = new Date(Date.now() + backoffSec * 1000);
    await this.db
      .update(etaxSubmissions)
      .set({
        status: 'pending',
        attempts: attempt,
        lastError: errMessage.slice(0, 1000),
        nextAttemptAt: next,
        updatedAt: new Date(),
      })
      .where(eq(etaxSubmissions.id, id));
    this.logger.warn(
      `etax submission ${id} retry #${attempt} in ${backoffSec}s: ${errMessage}`,
    );
  }

  /**
   * Operator: re-queue a DLQ row. Resets attempts to 0, status to pending,
   * clears next_attempt_at so the next tick picks it up.
   */
  async requeue(id: string): Promise<void> {
    await this.db
      .update(etaxSubmissions)
      .set({
        status: 'pending',
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: new Date(),
      })
      .where(eq(etaxSubmissions.id, id));
  }

  /** Operator: mark a row as DLQ manually (e.g. invoice was voided in RD portal). */
  async markDlq(id: string, reason: string): Promise<void> {
    await this.db
      .update(etaxSubmissions)
      .set({
        status: 'dlq',
        lastError: `manual DLQ: ${reason}`.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(etaxSubmissions.id, id));
  }

  /**
   * Stats by status — for operator dashboard. Lighter than a full list query.
   */
  async stats(): Promise<{
    pending: number;
    submitted: number;
    acknowledged: number;
    rejected: number;
    dlq: number;
  }> {
    const rows = await this.db.execute<{ status: string; count: string }>(sql`
      SELECT status, COUNT(*)::text AS count
        FROM custom.etax_submissions
       GROUP BY status
    `);
    const counts: Record<string, number> = {
      pending: 0,
      submitted: 0,
      acknowledged: 0,
      rejected: 0,
      dlq: 0,
    };
    for (const r of ((rows as any).rows ?? rows) as Array<{ status: string; count: string }>) {
      counts[r.status] = Number(r.count);
    }
    return {
      pending: counts.pending,
      submitted: counts.submitted,
      acknowledged: counts.acknowledged,
      rejected: counts.rejected,
      dlq: counts.dlq,
    };
  }

  /**
   * List submissions with filters — used by the operator dashboard.
   */
  async list(opts: {
    status?: 'pending' | 'submitted' | 'acknowledged' | 'rejected' | 'dlq';
    provider?: 'leceipt' | 'inet';
    limit?: number;
    offset?: number;
  } = {}): Promise<
    Array<{
      id: string;
      orderId: string;
      documentType: string;
      documentNumber: string;
      etdaCode: string;
      provider: string;
      status: string;
      attempts: number;
      lastError: string | null;
      rdReference: string | null;
      providerReference: string | null;
      ackTimestamp: Date | null;
      nextAttemptAt: Date | null;
      createdAt: Date | null;
      xmlHash: string;
    }>
  > {
    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.offset ?? 0;
    const filters: any[] = [];
    if (opts.status) filters.push(sql`status = ${opts.status}`);
    if (opts.provider) filters.push(sql`provider = ${opts.provider}`);
    const where = filters.length === 0
      ? sql`TRUE`
      : filters.reduce((acc, f, i) => (i === 0 ? f : sql`${acc} AND ${f}`));
    const rows = await this.db.execute(sql`
      SELECT id, order_id, document_type, document_number, etda_code, provider,
             status, attempts, last_error, rd_reference, provider_reference,
             ack_timestamp, next_attempt_at, created_at, xml_hash
        FROM custom.etax_submissions
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `);
    const flat = ((rows as any).rows ?? rows) as Array<Record<string, any>>;
    return flat.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      documentType: r.document_type,
      documentNumber: r.document_number,
      etdaCode: r.etda_code,
      provider: r.provider,
      status: r.status,
      attempts: Number(r.attempts ?? 0),
      lastError: r.last_error ?? null,
      rdReference: r.rd_reference ?? null,
      providerReference: r.provider_reference ?? null,
      ackTimestamp: r.ack_timestamp ?? null,
      nextAttemptAt: r.next_attempt_at ?? null,
      createdAt: r.created_at ?? null,
      xmlHash: r.xml_hash,
    }));
  }
}
