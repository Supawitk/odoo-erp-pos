import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

/**
 * Phase 1-2 closure: stale-session sweeper.
 *
 * Marks any `pos_sessions` left in `open` state for >24h as `abandoned`.
 * Real cashier flows always close before going home; abandoned rows are
 * artifacts of test runs or crashes, and they pile up if nothing prunes them.
 *
 * The cron does NOT auto-compute variance — abandoned sessions are not the
 * same as a closed session. They show up as `status='abandoned'` in the audit
 * and a manager can investigate; no money flow is implied.
 */
@Injectable()
export class SessionSweeperService {
  private readonly logger = new Logger(SessionSweeperService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Sweep stale `open` sessions. Triggered by BullMQ Job Scheduler
   * (`pos-session-sweeper`, 03:00 Asia/Bangkok daily).
   */
  async sweep(maxAgeHours = 24): Promise<{ swept: number }> {
    const r = await this.db.execute<{ id: string }>(sql`
      UPDATE custom.pos_sessions
         SET status = 'abandoned',
             closed_at = NOW()
       WHERE status = 'open'
         AND opened_at < NOW() - (${maxAgeHours}::int || ' hours')::interval
       RETURNING id
    `);
    const rows = (r as any).rows ?? r;
    if (rows.length > 0) {
      this.logger.log(`Stale session sweep: ${rows.length} marked abandoned`);
    }
    return { swept: rows.length };
  }
}
