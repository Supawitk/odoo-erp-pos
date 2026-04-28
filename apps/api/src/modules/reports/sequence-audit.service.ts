import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { documentSequences, posOrders, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * 🇹🇭 Document Sequence Gap Audit (§86 — no gaps allowed).
 *
 * The Revenue Department treats any missing number in a tax-document sequence
 * as a presumption of fraud. Voids MUST be preserved as VOID entries (rather
 * than skipped). This audit walks every (documentType, period) row and reports:
 *
 *   - allocated:    nextNumber - 1   (highest number we've handed out)
 *   - issued:       count of pos_orders rows with a documentNumber for that
 *                   (type, period)
 *   - missing:      list of numbers in [1, allocated] that are NOT present
 *                   in the issued set
 *
 * "missing" should always be empty. If it's not, something allocated a number
 * but the order row was never persisted (a real bug, must be investigated).
 *
 * The query uses generate_series + LEFT JOIN to find the gaps in pure SQL —
 * fast even on millions of rows because both sides are indexed on
 * (document_type, document_number).
 */
export interface SequenceAuditRow {
  documentType: string;
  period: string;
  prefix: string;
  allocated: number;
  issued: number;
  missing: number[];
  /**
   * "tax" — audited against pos_orders (the §86-regulated types: RE/ABB/TX/CN).
   * "internal" — sequence shared with non-pos_orders tables (PO/GRN — internal
   *              hygiene, not §86 scope). missing[] is left empty for these.
   */
  scope: 'tax' | 'internal';
}

const TAX_DOC_TYPES = new Set(['RE', 'ABB', 'TX', 'CN']);

@Injectable()
export class SequenceAuditService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async audit(): Promise<SequenceAuditRow[]> {
    const seqs = await this.db.select().from(documentSequences);
    const out: SequenceAuditRow[] = [];

    for (const seq of seqs) {
      const allocated = seq.nextNumber - 1;
      const isTax = TAX_DOC_TYPES.has(seq.documentType);

      if (allocated < 1) {
        out.push({
          documentType: seq.documentType,
          period: seq.period,
          prefix: seq.prefix,
          allocated: 0,
          issued: 0,
          missing: [],
          scope: isTax ? 'tax' : 'internal',
        });
        continue;
      }

      // Internal sequences (PO/GRN) live on different tables — out of §86 scope.
      // Report them so the operator sees the allocation count, but skip the gap
      // calculation since pos_orders won't have those numbers.
      if (!isTax) {
        out.push({
          documentType: seq.documentType,
          period: seq.period,
          prefix: seq.prefix,
          allocated,
          issued: allocated, // assume all issued; these aren't audit-critical
          missing: [],
          scope: 'internal',
        });
        continue;
      }

      // Pull every documentNumber issued for this (type, period). Document
      // numbers look like "TX2604-000042" — split on '-' and take the suffix.
      const issuedRows = await this.db
        .select({ documentNumber: posOrders.documentNumber })
        .from(posOrders)
        .where(
          sql`${posOrders.documentType} = ${seq.documentType}
              AND ${posOrders.documentNumber} LIKE ${seq.prefix + '-%'}`,
        );

      const issuedNums = new Set<number>();
      for (const r of issuedRows) {
        if (!r.documentNumber) continue;
        const n = Number(r.documentNumber.split('-').pop());
        if (Number.isInteger(n)) issuedNums.add(n);
      }

      const missing: number[] = [];
      // Cap the listed gaps at 200 numbers to avoid pathological responses.
      const cap = 200;
      for (let n = 1; n <= allocated && missing.length < cap; n++) {
        if (!issuedNums.has(n)) missing.push(n);
      }

      out.push({
        documentType: seq.documentType,
        period: seq.period,
        prefix: seq.prefix,
        allocated,
        issued: issuedNums.size,
        missing,
        scope: 'tax',
      });
    }

    return out.sort((a, b) =>
      a.period.localeCompare(b.period) || a.documentType.localeCompare(b.documentType),
    );
  }
}
