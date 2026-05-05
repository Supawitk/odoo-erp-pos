import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import {
  formatDocumentNumber,
  prefixFor,
  type DocumentType,
} from '../domain/document';

/**
 * Gapless document-number allocator.
 *
 * Strategy: INSERT ... ON CONFLICT DO UPDATE RETURNING next_number - 1 under
 * the row lock. Atomic, gapless, per (type, period) partition. The period is
 * YYYYMM — the standard Thai tax-invoice partitioning by fiscal month.
 *
 * §86 requires no gaps. If a caller reserves a number but the subsequent
 * commit fails, they MUST call `voidNumber()` so the cashier later reconciles
 * the void audit trail. The number itself is not re-issued; the void log is
 * the compliance artefact.
 */
@Injectable()
export class DocumentSequenceService {
  private readonly logger = new Logger(DocumentSequenceService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async allocate(
    type: DocumentType,
    now: Date = new Date(),
    branchCode: string = '00000',
  ): Promise<{
    number: string;
    sequence: number;
    period: string;
    prefix: string;
    branchCode: string;
  }> {
    const period = this.periodOf(now);
    const prefix = this.prefixOf(type, period, branchCode);

    const res = await this.db.execute<{ next_number: number }>(sql`
      INSERT INTO custom.document_sequences (document_type, period, branch_code, next_number, prefix)
      VALUES (${type}, ${period}, ${branchCode}, 2, ${prefix})
      ON CONFLICT (document_type, period, branch_code)
      DO UPDATE SET next_number = custom.document_sequences.next_number + 1, updated_at = now()
      RETURNING next_number - 1 AS next_number
    `);

    const sequence = Number(res[0]?.next_number ?? 1);
    const number = formatDocumentNumber(prefix, sequence);
    this.logger.log(
      `Allocated ${number} (type=${type} period=${period} branch=${branchCode} seq=${sequence})`,
    );
    return { number, sequence, period, prefix, branchCode };
  }

  /**
   * Peek current counter without advancing. Useful for UI hints like
   * "next invoice will be TX2604-000043". No locking — result is advisory.
   */
  async peek(
    type: DocumentType,
    now: Date = new Date(),
    branchCode: string = '00000',
  ): Promise<number> {
    const period = this.periodOf(now);
    const rows = await this.db.execute<{ next_number: number }>(sql`
      SELECT next_number FROM custom.document_sequences
      WHERE document_type = ${type}
        AND period = ${period}
        AND branch_code = ${branchCode}
      LIMIT 1
    `);
    return Number(rows[0]?.next_number ?? 1);
  }

  private periodOf(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}${m}`;
  }

  /**
   * 🇹🇭 §86/4 multi-branch prefix:
   *   - branch '00000' (head office) → legacy `TX2604`
   *   - branch '00099' → `00099-TX2604` so the final number is `00099-TX2604-000001`.
   * The branch dimension never collides with HQ even within the same period.
   */
  private prefixOf(type: DocumentType, period: string, branchCode: string): string {
    const base =
      type === 'CN' || type === 'DN'
        ? `${type}${period.slice(2)}`
        : prefixFor(type, period);
    return branchCode === '00000' ? base : `${branchCode}-${base}`;
  }
}
