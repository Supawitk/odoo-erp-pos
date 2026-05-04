import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Operational + security signals from custom.audit_events.
 *
 * Three classes:
 *   - security  : auth.token.reuse_detected (refresh-token theft attempt),
 *                 failed login attempts (auth.login.failed)
 *   - financial : voids (anything where event_type ILIKE '%void%'),
 *                 refunds (POST /api/pos/orders/.../refund)
 *   - operational: settings churn, bulk imports, manual journal entries
 *
 * Window defaults to last 7 days. Returns counts + the most recent N events
 * per class so the dashboard can show "what + when + by whom".
 */

export interface AnomalyEvent {
  id: string;
  aggregateType: string;
  eventType: string;
  userEmail: string | null;
  ipAddress: string | null;
  occurredAtIso: string;
  summary: string; // best-effort short description from event_data
}

export interface AuditAnomaliesReport {
  fromIso: string;
  toIso: string;
  counts: {
    tokenReuse: number;
    failedLogin: number;
    voids: number;
    refunds: number;
    settingsChanges: number;
    manualJournalEntries: number;
  };
  recent: {
    security: AnomalyEvent[];
    financial: AnomalyEvent[];
    operational: AnomalyEvent[];
  };
}

@Injectable()
export class AuditAnomaliesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async report(opts: { fromIso?: string; toIso?: string } = {}): Promise<AuditAnomaliesReport> {
    const now = new Date();
    const to = opts.toIso ? new Date(opts.toIso) : now;
    const from = opts.fromIso
      ? new Date(opts.fromIso)
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const countsRes = await this.db.execute<{
      token_reuse: number;
      failed_login: number;
      voids: number;
      refunds: number;
      settings_changes: number;
      manual_je: number;
    }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'auth.token.reuse_detected')::int                                 AS token_reuse,
        COUNT(*) FILTER (WHERE event_type ILIKE 'auth.login.failed%' OR event_type = 'auth.login.fail')::int  AS failed_login,
        COUNT(*) FILTER (WHERE event_type ILIKE '%void%')::int                                                AS voids,
        COUNT(*) FILTER (WHERE event_type ILIKE '%refund%')::int                                              AS refunds,
        COUNT(*) FILTER (WHERE event_type = 'PATCH /api/settings')::int                                       AS settings_changes,
        COUNT(*) FILTER (WHERE event_type ILIKE 'POST /api/accounting/journal-entries%')::int                 AS manual_je
      FROM custom.audit_events
      WHERE timestamp >= ${from.toISOString()}::timestamptz AND timestamp < ${to.toISOString()}::timestamptz
    `).then((res: any) => (res.rows ?? res ?? [{}]) as any[]);

    const counts = countsRes[0] ?? {};

    // Buckets for the recent-events lists.
    const securityPredicate = sql`(
      event_type = 'auth.token.reuse_detected'
      OR event_type ILIKE 'auth.login.failed%'
      OR event_type = 'auth.login.fail'
    )`;
    const financialPredicate = sql`(
      event_type ILIKE '%void%'
      OR event_type ILIKE '%refund%'
    )`;
    const operationalPredicate = sql`(
      event_type = 'PATCH /api/settings'
      OR event_type ILIKE 'POST /api/accounting/journal-entries%'
      OR event_type ILIKE 'POST /api/products/import%'
      OR event_type ILIKE 'POST /api/accounting/backfill/%'
    )`;

    const fetchRecent = async (predicate: any): Promise<AnomalyEvent[]> => {
      const res = await this.db.execute<{
        id: string;
        aggregate_type: string;
        event_type: string;
        user_email: string | null;
        ip_address: string | null;
        timestamp: string;
        event_data: any;
      }>(sql`
        SELECT id, aggregate_type, event_type, user_email, ip_address, timestamp, event_data
        FROM custom.audit_events
        WHERE timestamp >= ${from.toISOString()}::timestamptz AND timestamp < ${to.toISOString()}::timestamptz AND ${predicate}
        ORDER BY timestamp DESC
        LIMIT 5
      `);
      const rows: any[] = (res as any).rows ?? (res as any) ?? [];
      return rows.map((r) => ({
        id: r.id,
        aggregateType: r.aggregate_type,
        eventType: r.event_type,
        userEmail: r.user_email,
        ipAddress: r.ip_address,
        occurredAtIso: r.timestamp,
        summary: summarise(r.event_type, r.event_data),
      }));
    };

    const [security, financial, operational] = await Promise.all([
      fetchRecent(securityPredicate),
      fetchRecent(financialPredicate),
      fetchRecent(operationalPredicate),
    ]);

    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      counts: {
        tokenReuse: Number(counts.token_reuse ?? 0),
        failedLogin: Number(counts.failed_login ?? 0),
        voids: Number(counts.voids ?? 0),
        refunds: Number(counts.refunds ?? 0),
        settingsChanges: Number(counts.settings_changes ?? 0),
        manualJournalEntries: Number(counts.manual_je ?? 0),
      },
      recent: { security, financial, operational },
    };
  }
}

/**
 * Best-effort 1-line summary from the event_data jsonb. Falls back to the
 * raw event_type when the jsonb shape is unfamiliar.
 */
function summarise(eventType: string, data: any): string {
  if (!data || typeof data !== 'object') return eventType;
  // Audit interceptor stores the request body under `request` and the response
  // under `response`. Try a few common shapes.
  const reason = data.response?.reason ?? data.request?.reason;
  const id = data.response?.id ?? data.request?.id;
  const amount =
    data.response?.totalCents ??
    data.request?.totalCents ??
    data.response?.amountCents;
  const parts: string[] = [];
  if (id) parts.push(`#${String(id).slice(0, 8)}`);
  if (typeof amount === 'number') parts.push(`฿${(amount / 100).toFixed(2)}`);
  if (reason) parts.push(String(reason).slice(0, 80));
  return parts.join(' · ') || eventType;
}
