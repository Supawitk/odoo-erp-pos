import { Inject, Injectable, Logger } from '@nestjs/common';
import { lt } from 'drizzle-orm';
import { refreshTokens, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Refresh-token table grows by one row per /refresh and per /login. Without
 * cleanup, a year of daily logins per cashier produces thousands of rows.
 *
 * Retention rule:
 *   keep tokens whose expires_at is in the future OR within the last 30 days.
 *   Past that, the row is useless even for forensic queries — the access-
 *   token's 15-min validity has long since lapsed.
 *
 * The 30-day grace specifically lets a security team correlate a complaint
 * ("my account was compromised on the 14th") with a revoked-row reason
 * ('reused' / 'family_revoked') in the audit trail. After 30d we lose that
 * trace, but the audit_events row stays — it's the source of truth for the
 * incident itself.
 */

const GRACE_DAYS = 30;

@Injectable()
export class RefreshTokenCleanupService {
  private readonly logger = new Logger(RefreshTokenCleanupService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * 03:15 ICT daily — wired via JobsProcessor (BullMQ Job Schedulers v5).
   * Between the session-sweeper (03:00) and reclass cron (04:30).
   */
  async sweep() {
    try {
      const cutoff = new Date(Date.now() - GRACE_DAYS * 86400000);
      const deleted = await this.db
        .delete(refreshTokens)
        .where(lt(refreshTokens.expiresAt, cutoff))
        .returning({ id: refreshTokens.id });
      if (deleted.length > 0) {
        this.logger.log(
          `[cron] purged ${deleted.length} refresh-token rows past expires_at + ${GRACE_DAYS}d`,
        );
      }
    } catch (e) {
      this.logger.error(
        `[cron] refresh-token cleanup failed: ${(e as Error)?.message ?? e}`,
      );
    }
  }

  /** Manual trigger (used by the integration test + ops one-shot). */
  async runOnce(graceDays = GRACE_DAYS): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - graceDays * 86400000);
    const deleted = await this.db
      .delete(refreshTokens)
      .where(lt(refreshTokens.expiresAt, cutoff))
      .returning({ id: refreshTokens.id });
    return { deleted: deleted.length };
  }
}

