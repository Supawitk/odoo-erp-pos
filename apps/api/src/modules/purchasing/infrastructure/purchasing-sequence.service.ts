import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

/**
 * Sequence allocator for non-tax-invoice documents (PO, GRN). Uses the same
 * `custom.document_sequences` table as the §86 tax-invoice allocator, just
 * with different `document_type` values so partitions don't collide.
 *
 * Format: `PO2604-000123`. Like the §86 allocator, gapless within (type, period).
 */
@Injectable()
export class PurchasingSequenceService {
  private readonly logger = new Logger(PurchasingSequenceService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async allocate(
    type: 'PO' | 'GRN' | 'VB',
    now: Date = new Date(),
  ): Promise<{ number: string; sequence: number; period: string; prefix: string }> {
    const period = this.periodOf(now);
    const prefix = `${type}${period.slice(2)}`;

    const res = await this.db.execute<{ next_number: number }>(sql`
      INSERT INTO custom.document_sequences (document_type, period, next_number, prefix)
      VALUES (${type}, ${period}, 2, ${prefix})
      ON CONFLICT (document_type, period)
      DO UPDATE SET next_number = custom.document_sequences.next_number + 1, updated_at = now()
      RETURNING next_number - 1 AS next_number
    `);

    const sequence = Number(res[0]?.next_number ?? 1);
    const number = `${prefix}-${String(sequence).padStart(6, '0')}`;
    this.logger.log(`Allocated ${number} (type=${type} period=${period} seq=${sequence})`);
    return { number, sequence, period, prefix };
  }

  private periodOf(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}${m}`;
  }
}
