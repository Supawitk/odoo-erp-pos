import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { JOBS_QUEUE } from './jobs.constants';
import { JobsProcessor } from './jobs.processor';
import { JobsBootstrap } from './jobs.bootstrap';
import { InventoryModule } from '../../../modules/inventory/inventory.module';
import { PosModule } from '../../../modules/pos/pos.module';
import { ReportsModule } from '../../../modules/reports/reports.module';
import { AuthModule } from '../../../modules/auth/auth.module';
import { AccountingModule } from '../../../modules/accounting/accounting.module';

function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
  };
}

/**
 * BullMQ Job Schedulers v5 — replaces the per-service @Cron decorators with a
 * single shared queue + processor + scheduler. Multi-pod-safe (BullMQ's
 * scheduler is leadership-elected via Redis), persistent, observable.
 */
@Module({
  imports: [
    BullModule.forRoot({
      connection: parseRedisUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    }),
    BullModule.registerQueue({ name: JOBS_QUEUE }),
    InventoryModule,
    PosModule,
    ReportsModule,
    AuthModule,
    AccountingModule,
  ],
  providers: [JobsProcessor, JobsBootstrap],
})
export class JobsModule {}
