import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

/**
 * Sequence allocator for AR documents (SI sales-invoice, RC official receipt).
 * Shares `custom.document_sequences` with the §86 POS allocator and the
 * purchasing allocator — own (type, period) partitions, no collision.
 *
 * Format: `SI2604-000123`. Gapless within (type, period).
 */
@Injectable()
export class SalesSequenceService {
  private readonly logger = new Logger(SalesSequenceService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async allocate(
    type: 'SI' | 'RC',
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
    const baseprefix = `${type}${period.slice(2)}`;
    const prefix = branchCode === '00000' ? baseprefix : `${branchCode}-${baseprefix}`;

    const res = await this.db.execute<{ next_number: number }>(sql`
      INSERT INTO custom.document_sequences (document_type, period, branch_code, next_number, prefix)
      VALUES (${type}, ${period}, ${branchCode}, 2, ${prefix})
      ON CONFLICT (document_type, period, branch_code)
      DO UPDATE SET next_number = custom.document_sequences.next_number + 1, updated_at = now()
      RETURNING next_number - 1 AS next_number
    `);

    const sequence = Number(res[0]?.next_number ?? 1);
    const number = `${prefix}-${String(sequence).padStart(6, '0')}`;
    this.logger.log(
      `Allocated ${number} (type=${type} period=${period} branch=${branchCode} seq=${sequence})`,
    );
    return { number, sequence, period, prefix, branchCode };
  }

  private periodOf(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}${m}`;
  }
}
