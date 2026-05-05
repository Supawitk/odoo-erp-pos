import {
  uuid,
  text,
  bigint,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { customSchema, users } from './auth';

/**
 * Tier validation — local mirror of OCA `tier.validation` so the same approval
 * concept works without round-tripping every approval to Odoo. Field names
 * intentionally match OCA's so we can sync bidirectionally later.
 *
 * `tier_definitions` is the rule (e.g. "refunds over ฿1000 require manager").
 * `tier_reviews` is one runtime row per (definition × target aggregate).
 *
 * `target_kind` enumerates aggregates we currently know how to gate:
 *   pos.refund     — refund-order command
 *   po.confirm     — purchase-order confirm command
 *   pos.void       — void-order command
 *   accounting.je  — manual journal-entry post
 *
 * The `condition_expr` (a tiny safe expression like `amount > 100000`) decides
 * whether a rule applies to this particular aggregate. The matcher lives in
 * `apps/api/src/modules/approvals/condition.ts` and is the only place a
 * definition string can produce side effects.
 */
export const tierDefinitions = customSchema.table(
  'tier_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Aggregate this rule guards. Closed enum to avoid typo drift. */
    targetKind: text('target_kind').notNull(),
    /**
     * Tiny boolean-returning expression evaluated against the request payload.
     * Empty / null = always applies. Examples:
     *   "amount > 100000"
     *   "amount > 5000000 && currency == 'THB'"
     *   "isPartial"
     */
    conditionExpr: text('condition_expr'),
    /** When two rules apply, the lower sequence approves first. */
    sequence: integer('sequence').notNull().default(10),
    /**
     * Reviewers who can approve this tier. Empty = any admin. UUIDs reference
     * custom.users.id; non-FK so a deleted user doesn't cascade-delete the
     * definition (we just lose that one reviewer).
     */
    reviewerIds: jsonb('reviewer_ids').notNull().default([]),
    /** When false, the rule is bypassed (kept for audit trail). */
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    activeKindIdx: index('tier_def_kind_active_idx').on(t.targetKind, t.isActive),
  }),
);

/**
 * One review row per (definition × target). State machine:
 *   pending → approved   (reviewer clicks approve)
 *   pending → rejected   (reviewer clicks reject)
 *   pending → cancelled  (target was abandoned before approval)
 *
 * `target_kind + target_id` uniquely identifies the thing being reviewed.
 * For refunds the target is the original-order id (we create the review
 * before the refund order exists). For PO confirm it's the PO id, etc.
 */
export const tierReviews = customSchema.table(
  'tier_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    definitionId: uuid('definition_id').notNull().references(() => tierDefinitions.id, {
      onDelete: 'restrict',
    }),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    status: text('status').notNull().default('pending'), // pending|approved|rejected|cancelled
    /** Whoever filed the request (may differ from reviewer). */
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
    /** Whoever resolved it. */
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Free text from the reviewer (rejection reason, approval note). */
    resolverComment: text('resolver_comment'),
    /**
     * The payload the request was made with — used by the executor when the
     * review flips to `approved`. Stored here so a stale UI tab can't spoof
     * a different amount on resolution.
     */
    payload: jsonb('payload').notNull().default({}),
    /** Free text from the requester explaining why. */
    requesterComment: text('requester_comment'),
  },
  (t) => ({
    targetIdx: index('tier_rev_target_idx').on(t.targetKind, t.targetId, t.status),
    // Partial-unique "one pending review per (definition, target)" is created
    // out-of-band via raw SQL migration since Drizzle 0.45 can't express the
    // WHERE clause cleanly. See the live ALTER in the same session.
  }),
);

/**
 * Audit log of every state transition on a review. Append-only.
 */
export const tierReviewEvents = customSchema.table(
  'tier_review_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    reviewId: uuid('review_id').notNull().references(() => tierReviews.id, {
      onDelete: 'cascade',
    }),
    event: text('event').notNull(), // requested|approved|rejected|cancelled|resubmitted
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    reviewIdx: index('tier_rev_event_review_idx').on(t.reviewId, t.createdAt),
  }),
);
