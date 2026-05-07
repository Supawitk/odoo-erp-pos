import { Logger, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { JOBS_QUEUE, type JobName } from './jobs.constants';
import { OutboxRelayService } from '../../../modules/inventory/infrastructure/outbox-relay.service';
import { OdooCatalogPullService } from '../../../modules/inventory/infrastructure/odoo-catalog-pull.service';
import { ReconciliationCronService } from '../../../modules/inventory/infrastructure/reconciliation-cron.service';
import { ExpiryCronService } from '../../../modules/inventory/infrastructure/expiry-cron.service';
import { SessionSweeperService } from '../../../modules/pos/infrastructure/session-sweeper.service';
import { GoodsReportCronService } from '../../../modules/reports/goods-report-cron.service';
import { InputVatReclassService } from '../../../modules/reports/input-vat-reclass.service';
import { RefreshTokenCleanupService } from '../../../modules/auth/refresh-token-cleanup.service';
import { DepreciationCronService } from '../../../modules/accounting/infrastructure/depreciation.cron';
import { EtaxRelayService } from '../../../modules/etax/services/etax-relay.service';

/**
 * Single processor for the `jobs` queue. Dispatches by `job.name` so we have
 * one BullMQ worker + one Bull-Board view for all background work.
 *
 * Each handler stays a one-liner — the actual work lives in the original cron
 * services so unit tests can drive them directly.
 */
@Processor(JOBS_QUEUE)
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(
    @Optional() private readonly outboxRelay: OutboxRelayService | null,
    @Optional() private readonly catalogPull: OdooCatalogPullService | null,
    @Optional() private readonly reconcile: ReconciliationCronService | null,
    @Optional() private readonly expiry: ExpiryCronService | null,
    @Optional() private readonly sessionSweeper: SessionSweeperService | null,
    @Optional() private readonly goodsReport: GoodsReportCronService | null,
    @Optional() private readonly inputVatReclass: InputVatReclassService | null,
    @Optional() private readonly refreshTokenCleanup: RefreshTokenCleanupService | null,
    @Optional() private readonly depreciation: DepreciationCronService | null,
    @Optional() private readonly etaxRelay: EtaxRelayService | null,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const name = job.name as JobName;
    this.logger.log(`Job tick: ${name}`);
    switch (name) {
      case 'odoo-outbox-relay':
        return this.outboxRelay?.run();
      case 'odoo-catalog-pull':
        return this.catalogPull?.pull();
      case 'odoo-stock-reconcile':
        return this.reconcile?.run();
      case 'inventory-expiry-scan':
        return this.expiry?.scan(30);
      case 'pos-session-sweeper':
        return this.sessionSweeper?.sweep();
      case 'daily-goods-report':
        return this.goodsReport?.runDaily();
      case 'input-vat-reclass':
        return this.inputVatReclass?.run({ dryRun: false, postedBy: null });
      case 'refresh-token-cleanup':
        return this.refreshTokenCleanup?.sweep();
      case 'monthly-depreciation':
        return this.depreciation?.run();
      case 'etax-relay':
        return this.etaxRelay?.run();
      default:
        this.logger.warn(`Unknown job name: ${name}`);
        return undefined;
    }
  }
}
