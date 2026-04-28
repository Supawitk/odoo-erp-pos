import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { JOBS_QUEUE, JOB_SCHEDULES } from './jobs.constants';

/**
 * On startup, register a Job Scheduler for each cron pattern. BullMQ's
 * `upsertJobScheduler` is idempotent — multi-pod deployments can all call this
 * and the scheduler key is unique per (queue, name), so duplicates collapse.
 */
@Injectable()
export class JobsBootstrap implements OnModuleInit {
  private readonly logger = new Logger(JobsBootstrap.name);

  constructor(@InjectQueue(JOBS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    for (const [name, schedule] of Object.entries(JOB_SCHEDULES)) {
      await this.queue.upsertJobScheduler(
        name,
        { pattern: schedule.pattern, tz: schedule.tz },
        { name, data: {}, opts: { removeOnComplete: 1000, removeOnFail: 5000 } },
      );
      this.logger.log(`Scheduler registered: ${name} (${schedule.pattern} ${schedule.tz})`);
    }
  }
}
