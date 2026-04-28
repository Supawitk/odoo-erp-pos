import { uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { customSchema } from './auth';

// Immutable audit trail (event sourcing)
export const auditEvents = customSchema.table(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregateType: text('aggregate_type').notNull(), // journal_entry, pos_order, stock_move
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(), // created, posted, voided, updated
    eventData: jsonb('event_data').notNull(),
    userId: uuid('user_id'),
    userEmail: text('user_email'),
    ipAddress: text('ip_address'),
    timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    aggregateIdx: index('audit_aggregate_idx').on(
      table.aggregateType,
      table.aggregateId,
    ),
    timestampIdx: index('audit_timestamp_idx').on(table.timestamp),
  }),
);

// Odoo sync tracking
export const syncLog = customSchema.table(
  'sync_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    model: text('model').notNull(), // product.product, res.partner
    odooId: text('odoo_id').notNull(),
    direction: text('direction').notNull(), // odoo_to_local, local_to_odoo
    status: text('status').notNull(), // success, failed, conflict
    dataHash: text('data_hash'),
    errorMessage: text('error_message'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    modelIdx: index('sync_model_idx').on(table.model, table.odooId),
  }),
);
