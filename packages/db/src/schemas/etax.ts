import {
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { customSchema } from './auth';
import { posOrders } from './pos';

/**
 * 🇹🇭 e-Tax invoice submission log (Phase 4B).
 *
 * One row per submission attempt to ETDA / RD via an ASP (Leceipt or INET) or
 * direct H2H. The XML payload + ack are kept indefinitely because §87/3 requires
 * 5-year retention of the *signed* document, not just the human-readable PDF.
 *
 * status lifecycle:
 *   pending      — XML built, not yet shipped
 *   submitted    — ASP accepted, awaiting RD ack
 *   acknowledged — RD acknowledged (terminal success)
 *   rejected     — RD or ASP rejected (terminal failure; see lastError)
 *   dlq          — exceeded retry budget; manual intervention required
 */
export const etaxSubmissions = customSchema.table(
  'etax_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** FK to pos_orders. Same row can be re-submitted on transient failure. */
    orderId: uuid('order_id').notNull().references(() => posOrders.id),
    /** RE | ABB | TX | CN | DN — mirrors pos_orders.document_type. */
    documentType: text('document_type').notNull(),
    /** TX2604-000042 etc. — mirrors pos_orders.document_number. */
    documentNumber: text('document_number').notNull(),
    /** ETDA T-code: T01..T05 (invoice/credit-note/debit-note flavours). */
    etdaCode: text('etda_code').notNull(),
    /** Provider: leceipt | inet | direct. */
    provider: text('provider').notNull(),
    /** pending | submitted | acknowledged | rejected | dlq */
    status: text('status').notNull().default('pending'),
    /** Generated CrossIndustryInvoice 2.0 XML, gzip-able later. */
    xmlPayload: text('xml_payload').notNull(),
    /** Sha256 hex of xmlPayload — tamper-detect after signing. */
    xmlHash: text('xml_hash').notNull(),
    /** RD-issued reference number, populated on ack. */
    rdReference: text('rd_reference'),
    /** Provider's internal id (Leceipt doc id, INET tracking id). */
    providerReference: text('provider_reference'),
    /** Provider response payload — full body for forensic replay. */
    providerResponse: jsonb('provider_response'),
    /** When provider acked. */
    ackTimestamp: timestamp('ack_timestamp', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    orderIdx: index('etax_submissions_order_idx').on(table.orderId),
    statusIdx: index('etax_submissions_status_idx').on(table.status, table.nextAttemptAt),
    docNumIdx: index('etax_submissions_doc_idx').on(table.documentType, table.documentNumber),
  }),
);
