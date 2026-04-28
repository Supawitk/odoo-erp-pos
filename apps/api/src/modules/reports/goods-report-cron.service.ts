import { Injectable, Logger } from '@nestjs/common';
import { GoodsReportService } from './goods-report.service';
import { OrganizationService } from '../organization/organization.service';

/**
 * 🇹🇭 Daily auto-generation of รายงานสินค้าและวัตถุดิบ.
 *
 * RD Director-General Notice No. 89 §9 mandates ≤T+3 business days. Triggered
 * by BullMQ Job Scheduler (`daily-goods-report`, 02:00 Asia/Bangkok daily).
 *
 * The cron logs the per-branch summary; on-demand PDF retrieval lives at
 * `/api/reports/goods-report.pdf`.
 *
 * Skip when not in Thai mode.
 */
@Injectable()
export class GoodsReportCronService {
  private readonly logger = new Logger(GoodsReportCronService.name);
  private running = false;

  constructor(
    private readonly goodsReport: GoodsReportService,
    private readonly org: OrganizationService,
  ) {}

  async runDaily(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const settings = await this.org.snapshot();
      if (settings.countryMode !== 'TH') {
        this.logger.debug('Skipping goods-report cron — countryMode is not TH');
        return;
      }
      const today = new Date();
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const day = yesterday.toISOString().slice(0, 10);
      const result = await this.goodsReport.getReport({ fromDate: day, toDate: day });
      this.logger.log(
        `Daily goods report ${day}: ${result.summary.rowCount} rows, ` +
          `qty in/out=${result.summary.totalQtyIn}/${result.summary.totalQtyOut}, ` +
          `value in/out=${result.summary.totalValueInCents}/${result.summary.totalValueOutCents} satang`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Manual run, returns the summary. Useful for /reports/goods-report/run-now. */
  async runForDate(day: string) {
    return this.goodsReport.getReport({ fromDate: day, toDate: day });
  }
}
