import { Injectable, Logger } from '@nestjs/common';
import { FixedAssetsService } from '../application/fixed-assets.service';

/**
 * Monthly depreciation runner. Triggered by BullMQ Job Scheduler
 * `monthly-depreciation` on the 1st of each month at 02:00 ICT for the
 * *previous* month (so the prior period is fully closed before we depreciate).
 *
 * Idempotent — assets that already have a depreciation_entry for the period
 * are skipped, so re-runs (manual or cron retry) are safe.
 */
@Injectable()
export class DepreciationCronService {
  private readonly logger = new Logger(DepreciationCronService.name);
  private running = false;

  constructor(private readonly fixedAssets: FixedAssetsService) {}

  async run(): Promise<void> {
    if (this.running) {
      this.logger.warn('Depreciation cron already running — skipping overlap');
      return;
    }
    this.running = true;
    try {
      // Run for the *previous* calendar month so books are closed first.
      const now = new Date();
      const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const year = prev.getUTCFullYear();
      const month = prev.getUTCMonth() + 1;
      // Don't pass postedBy — posted_by is a uuid column for a real user actor,
      // not a free-form string. Cron-posted JEs simply have posted_by NULL.
      const result = await this.fixedAssets.runMonthlyDepreciation(year, month);
      this.logger.log(
        `Depreciation ${result.period}: posted=${result.posted} skipped=${result.skipped} errors=${result.errors.length}/${result.assetCount}`,
      );
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          this.logger.error(`Depreciation failed for asset ${err.assetId}: ${err.reason}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
