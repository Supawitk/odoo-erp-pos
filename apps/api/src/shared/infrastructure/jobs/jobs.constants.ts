/** Single queue for all background work (Phase 3 → Phase 5). */
export const JOBS_QUEUE = 'jobs';

/**
 * Job names + their cron patterns. The processor dispatches by `job.name`.
 * Patterns use BullMQ Job Scheduler syntax (5-field cron + tz).
 */
export const JOB_SCHEDULES = {
  'odoo-outbox-relay': { pattern: '* * * * *', tz: 'Asia/Bangkok' }, // every minute
  'odoo-catalog-pull': { pattern: '*/5 * * * *', tz: 'Asia/Bangkok' }, // every 5 minutes
  'odoo-stock-reconcile': { pattern: '30 2 * * *', tz: 'Asia/Bangkok' }, // 02:30 daily
  'inventory-expiry-scan': { pattern: '0 9 * * *', tz: 'Asia/Bangkok' }, // 09:00 daily
  'pos-session-sweeper': { pattern: '0 3 * * *', tz: 'Asia/Bangkok' }, // 03:00 daily
  'refresh-token-cleanup': { pattern: '15 3 * * *', tz: 'Asia/Bangkok' }, // 03:15 daily
  'daily-goods-report': { pattern: '0 2 * * *', tz: 'Asia/Bangkok' }, // 02:00 daily
  'input-vat-reclass': { pattern: '30 4 * * *', tz: 'Asia/Bangkok' }, // 04:30 daily
  'monthly-depreciation': { pattern: '0 2 1 * *', tz: 'Asia/Bangkok' }, // 02:00 on day 1 of each month
} as const;

export type JobName = keyof typeof JOB_SCHEDULES;
