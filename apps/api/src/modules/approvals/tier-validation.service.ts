import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  tierDefinitions,
  tierReviews,
  tierReviewEvents,
  users,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { matchesCondition } from './condition';
import {
  ApprovalAlreadyResolvedError,
  ApprovalForbiddenReviewerError,
  ApprovalNotFoundError,
  ApprovalRequiredError,
} from './approvals.errors';

/**
 * Closed enum of aggregates that can be tier-gated. Add a new value here
 * AND in the controller's KIND list when wiring a new domain operation.
 *
 * `pos.void` was reserved earlier but voiding paid orders flows through
 * the refund/CN path — no separate void exists. Removed from the enum so
 * a typo can't create dead reviews; re-add when an explicit void command
 * (state flip without CN) is needed.
 */
export type TargetKind =
  | 'pos.refund'
  | 'po.confirm'
  | 'accounting.je';

export interface AssertOpts {
  /** Closed-enum aggregate kind. */
  kind: TargetKind;
  /** Aggregate id (order id, PO id, JE id). */
  targetId: string;
  /** Context bag the conditionExpr runs against (e.g. {amount: 200000}). */
  context: Record<string, unknown>;
  /** User filing the request — for audit. */
  requestedBy?: string;
  /** Free-text comment from the requester. Stored on the review. */
  comment?: string;
  /**
   * Caller-supplied bypass: whoever is in this list is allowed to override.
   * Used for explicit manager override on the same request (e.g. the cashier
   * passes their manager's user id in `varianceApprovedBy`).
   */
  preApprovedBy?: string;
}

/**
 * Single source of truth for "does this aggregate need approval before it
 * can advance?". Callers either:
 *
 *   1. Call `assertApproved(opts)` BEFORE doing the mutation. If approval is
 *      required but not yet given, this method creates pending review rows
 *      and throws `ApprovalRequiredError` with their ids — the request fails
 *      with HTTP 422 and the UI tells the user to click "Request approval".
 *
 *   2. Or, call `requestApproval(opts)` to explicitly create reviews and
 *      return their ids without throwing — used when the caller wants to
 *      decouple "ask" from "do".
 *
 * Reviewers later call `approve(reviewId, by)` / `reject(reviewId, by)` —
 * those flips don't execute the original mutation. Callers re-submit the
 * original request after all blocking reviews are approved; the service
 * sees the approval and lets the call through.
 */
@Injectable()
export class TierValidationService {
  private readonly logger = new Logger(TierValidationService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Throws `ApprovalRequiredError` if any active definition for `kind`
   * matches the context AND no approved review exists yet for the same
   * (definition × target). Ensures pending reviews are created on first call
   * so the next /approvals fetch sees them.
   */
  async assertApproved(opts: AssertOpts): Promise<void> {
    const { kind, targetId, context, requestedBy, comment, preApprovedBy } = opts;

    const defs = await this.db
      .select()
      .from(tierDefinitions)
      .where(and(eq(tierDefinitions.targetKind, kind), eq(tierDefinitions.isActive, true)))
      .orderBy(asc(tierDefinitions.sequence));

    const matching = defs.filter((d) => matchesCondition(d.conditionExpr, context));
    if (matching.length === 0) return; // no rule applies — pass through

    const existing = await this.db
      .select()
      .from(tierReviews)
      .where(and(eq(tierReviews.targetKind, kind), eq(tierReviews.targetId, targetId)));

    // Sequence-ordered processing: lower `sequence` approves first. We only
    // *create* a pending review for the next rule once every earlier rule is
    // already approved (or pre-approved on this submit). Higher-sequence
    // rules without prior reviews are silently held back so they don't clog
    // the approver's inbox.
    const blocking: string[] = [];
    let blockedAtSequence: number | null = null;

    for (const def of matching) {
      // If we already saw a blocking review at a lower sequence, only collect
      // existing rows for this rule (so resubmissions stay idempotent) but
      // don't create new ones.
      const reviewerIds = readReviewerIds(def.reviewerIds);
      const prior = existing.find((r) => r.definitionId === def.id);

      if (prior?.status === 'approved') continue; // tier cleared

      // pre-approved bypass for this rule
      if (preApprovedBy && (reviewerIds.length === 0 || reviewerIds.includes(preApprovedBy))) {
        const synth = await this.upsertReview(def.id, kind, targetId, context, requestedBy, comment);
        await this.resolve(synth.id, 'approved', preApprovedBy, 'pre-approved at submit');
        continue;
      }

      if (blockedAtSequence !== null && def.sequence > blockedAtSequence) {
        // Don't create a fresh pending row past the first blocking tier.
        // If a row already exists from an earlier flow, surface it; otherwise
        // skip silently — the approver shouldn't see tier 30 while tier 10
        // is still pending.
        if (prior?.status === 'pending') blocking.push(prior.id);
        continue;
      }

      if (prior?.status === 'rejected') {
        const fresh = await this.upsertReview(def.id, kind, targetId, context, requestedBy, comment);
        blocking.push(fresh.id);
        if (blockedAtSequence === null) blockedAtSequence = def.sequence;
        continue;
      }
      if (prior?.status === 'pending') {
        blocking.push(prior.id);
        if (blockedAtSequence === null) blockedAtSequence = def.sequence;
        continue;
      }
      // No prior at this sequence — create.
      const fresh = await this.upsertReview(def.id, kind, targetId, context, requestedBy, comment);
      blocking.push(fresh.id);
      if (blockedAtSequence === null) blockedAtSequence = def.sequence;
    }

    if (blocking.length > 0) {
      throw new ApprovalRequiredError(
        `${blocking.length} approval${blocking.length === 1 ? '' : 's'} required for ${kind} ${targetId}`,
        blocking,
      );
    }
  }

  /**
   * Same as assertApproved but never throws — returns the list of pending
   * review ids. Useful when the caller wants to gather but not yet block.
   */
  async requestApproval(opts: AssertOpts): Promise<string[]> {
    try {
      await this.assertApproved(opts);
      return [];
    } catch (e) {
      if (e instanceof ApprovalRequiredError) return e.reviewIds;
      throw e;
    }
  }

  async approve(reviewId: string, actorId: string, comment?: string) {
    return this.resolve(reviewId, 'approved', actorId, comment);
  }

  async reject(reviewId: string, actorId: string, comment?: string) {
    return this.resolve(reviewId, 'rejected', actorId, comment);
  }

  async cancelForTarget(kind: TargetKind, targetId: string, actorId?: string) {
    const pending = await this.db
      .select()
      .from(tierReviews)
      .where(
        and(
          eq(tierReviews.targetKind, kind),
          eq(tierReviews.targetId, targetId),
          eq(tierReviews.status, 'pending'),
        ),
      );
    for (const r of pending) {
      await this.resolve(r.id, 'cancelled', actorId, 'target cancelled');
    }
  }

  async listPending(reviewerId?: string) {
    const rows = await this.db
      .select({
        review: tierReviews,
        definition: tierDefinitions,
        requesterEmail: users.email,
        requesterName: users.name,
      })
      .from(tierReviews)
      .leftJoin(tierDefinitions, eq(tierDefinitions.id, tierReviews.definitionId))
      .leftJoin(users, eq(users.id, tierReviews.requestedBy))
      .where(eq(tierReviews.status, 'pending'))
      .orderBy(desc(tierReviews.requestedAt))
      .limit(200);

    // Sequence ordering: hide a pending review whose target has another
    // pending review at a lower sequence. The lower one must clear first.
    // We compute the per-target minimum-pending sequence in one pass.
    const minPendingSeq = new Map<string, number>();
    for (const r of rows) {
      const seq = r.definition?.sequence ?? Number.MAX_SAFE_INTEGER;
      const key = `${r.review.targetKind}:${r.review.targetId}`;
      const cur = minPendingSeq.get(key);
      if (cur === undefined || seq < cur) minPendingSeq.set(key, seq);
    }
    const ordered = rows.filter((r) => {
      const key = `${r.review.targetKind}:${r.review.targetId}`;
      const minSeq = minPendingSeq.get(key) ?? Number.MAX_SAFE_INTEGER;
      const seq = r.definition?.sequence ?? Number.MAX_SAFE_INTEGER;
      return seq === minSeq; // only the leading tier surfaces
    });

    if (!reviewerId) return ordered;

    return ordered.filter((r) => {
      const list = readReviewerIds(r.definition?.reviewerIds);
      return list.length === 0 || list.includes(reviewerId);
    });
  }

  async getReviewsForTargets(kind: TargetKind, targetIds: string[]) {
    if (targetIds.length === 0) return [];
    return this.db
      .select()
      .from(tierReviews)
      .where(and(eq(tierReviews.targetKind, kind), inArray(tierReviews.targetId, targetIds)));
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private async upsertReview(
    definitionId: string,
    kind: TargetKind,
    targetId: string,
    payload: Record<string, unknown>,
    requestedBy?: string,
    comment?: string,
  ) {
    // The partial-unique index (definition_id, target_kind, target_id WHERE status='pending')
    // guarantees we don't duplicate a pending row. ON CONFLICT-style upsert
    // isn't possible here (partial UNIQUE can't be used as ON CONFLICT target
    // pre-PG15 fully cleanly), so we read-then-insert with the index as the
    // backstop.
    const existing = await this.db
      .select()
      .from(tierReviews)
      .where(
        and(
          eq(tierReviews.definitionId, definitionId),
          eq(tierReviews.targetKind, kind),
          eq(tierReviews.targetId, targetId),
          eq(tierReviews.status, 'pending'),
        ),
      )
      .limit(1);

    if (existing.length > 0) return existing[0];

    const [row] = await this.db
      .insert(tierReviews)
      .values({
        definitionId,
        targetKind: kind,
        targetId,
        status: 'pending',
        requestedBy: requestedBy ?? null,
        payload,
        requesterComment: comment ?? null,
      })
      .returning();

    await this.db.insert(tierReviewEvents).values({
      reviewId: row.id,
      event: 'requested',
      actorId: requestedBy ?? null,
      payload: { context: payload },
    });

    return row;
  }

  private async resolve(
    reviewId: string,
    next: 'approved' | 'rejected' | 'cancelled',
    actorId?: string,
    comment?: string,
  ) {
    const [review] = await this.db
      .select()
      .from(tierReviews)
      .where(eq(tierReviews.id, reviewId))
      .limit(1);
    if (!review) throw new ApprovalNotFoundError(reviewId);
    if (review.status !== 'pending') {
      throw new ApprovalAlreadyResolvedError(reviewId, review.status);
    }

    if (next !== 'cancelled' && actorId) {
      // Reviewer authorisation check — the action endpoint should have
      // already verified admin role; this is defence in depth.
      const [def] = await this.db
        .select()
        .from(tierDefinitions)
        .where(eq(tierDefinitions.id, review.definitionId))
        .limit(1);
      if (def) {
        const list = readReviewerIds(def.reviewerIds);
        if (list.length > 0 && !list.includes(actorId)) {
          throw new ApprovalForbiddenReviewerError(reviewId);
        }
      }
    }

    const [updated] = await this.db
      .update(tierReviews)
      .set({
        status: next,
        resolvedBy: actorId ?? null,
        resolvedAt: new Date(),
        resolverComment: comment ?? null,
      })
      .where(eq(tierReviews.id, reviewId))
      .returning();

    await this.db.insert(tierReviewEvents).values({
      reviewId,
      event: next,
      actorId: actorId ?? null,
      payload: { comment: comment ?? null },
    });

    this.logger.log(`Review ${reviewId} → ${next} by ${actorId ?? '(system)'}`);
    return updated;
  }
}

function readReviewerIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}
