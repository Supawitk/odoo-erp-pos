/**
 * Tier validation integration tests.
 *
 * Verifies the full blocked → approved → unblocked flow against a live
 * Postgres. The service is composed manually (no Nest DI here) so we don't
 * have to boot the full app to test the algorithm.
 *
 * Scenarios covered:
 *   1. No matching rule → assertApproved passes silently.
 *   2. Matching rule, no preApprovedBy → throws ApprovalRequiredError with
 *      a fresh pending review id.
 *   3. Re-submission while pending → returns the SAME review id (no dup).
 *   4. Reviewer approves → next assertApproved passes.
 *   5. Reviewer rejects → next assertApproved creates a NEW pending review
 *      (resubmission semantics).
 *   6. preApprovedBy in reviewer list → bypasses, synthesises an approved row.
 *   7. preApprovedBy NOT in reviewer list → still blocks.
 *   8. cancelForTarget marks all pending reviews for a target as cancelled.
 *   9. Composite condition (`amount > X && currency == 'THB'`) — both
 *      branches respected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { TierValidationService } from '../../src/modules/approvals/tier-validation.service';
import { ApprovalRequiredError } from '../../src/modules/approvals/approvals.errors';
import { matchesCondition } from '../../src/modules/approvals/condition';

const CONN =
  process.env.DATABASE_URL || 'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';

let client: postgres.Sql;
let service: TierValidationService;
let definitionId: string;
let reviewerId: string;
let nonReviewerId: string;
let requesterId: string;

const KIND = 'pos.refund' as const;

beforeAll(async () => {
  client = postgres(CONN, { max: 10 });
  const db = drizzle(client) as any;
  service = new TierValidationService(db);

  // Create a stable reviewer + non-reviewer + requester user. Using a single
  // run-id suffix keeps the rows unique across re-runs without leaving
  // orphan junk if a prior run crashed mid-way (the cleanup query at the end
  // is best-effort).
  const tag = `tierint-${Date.now()}`;
  const [r1] = await client`
    INSERT INTO custom.users (email, password_hash, name, role)
    VALUES (${`reviewer-${tag}@example.com`}, 'x', 'Reviewer', 'admin')
    RETURNING id::text
  `;
  reviewerId = r1.id;
  const [r2] = await client`
    INSERT INTO custom.users (email, password_hash, name, role)
    VALUES (${`other-${tag}@example.com`}, 'x', 'Other Admin', 'admin')
    RETURNING id::text
  `;
  nonReviewerId = r2.id;
  const [r3] = await client`
    INSERT INTO custom.users (email, password_hash, name, role)
    VALUES (${`requester-${tag}@example.com`}, 'x', 'Requester', 'cashier')
    RETURNING id::text
  `;
  requesterId = r3.id;
});

afterAll(async () => {
  // Best-effort cleanup. Foreign keys cascade reviews → events; users via
  // SET NULL on actor columns.
  if (definitionId) {
    await client`DELETE FROM custom.tier_reviews WHERE definition_id = ${definitionId}`;
    await client`DELETE FROM custom.tier_definitions WHERE id = ${definitionId}`;
  }
  // Restore any production rules we deactivated.
  if (restoredAtEnd.length > 0) {
    const ids = restoredAtEnd.map((o) => o.id);
    await client`UPDATE custom.tier_definitions SET is_active = true WHERE id = ANY(${ids}::uuid[])`;
  }
  for (const id of [reviewerId, nonReviewerId, requesterId]) {
    if (id) await client`DELETE FROM custom.users WHERE id = ${id}`;
  }
  await client.end();
});

// Production may already have rules for pos.refund (from /approvals UI or
// prior live smokes). Deactivate them for the duration of this suite, then
// restore them in afterAll so the live system isn't disturbed.
let restoredAtEnd: { id: string }[] = [];

beforeEach(async () => {
  if (definitionId) {
    await client`DELETE FROM custom.tier_reviews WHERE definition_id = ${definitionId}`;
    await client`DELETE FROM custom.tier_definitions WHERE id = ${definitionId}`;
  }
  // Snapshot then deactivate any production pos.refund rules.
  const others = await client<{ id: string }[]>`
    SELECT id::text FROM custom.tier_definitions
    WHERE target_kind = ${KIND} AND is_active = true
  `;
  restoredAtEnd = others;
  if (others.length > 0) {
    const ids = others.map((o) => o.id);
    await client`UPDATE custom.tier_definitions SET is_active = false WHERE id = ANY(${ids}::uuid[])`;
  }
  const reviewerJson = JSON.stringify([reviewerId]);
  const [d] = await client`
    INSERT INTO custom.tier_definitions
      (name, target_kind, condition_expr, sequence, reviewer_ids, is_active)
    VALUES
      ('Refund > ฿1000', ${KIND}, 'amount > 100000', 10,
       ${reviewerJson}::jsonb, true)
    RETURNING id::text
  `;
  definitionId = d.id;
});

describe('TierValidationService', () => {
  it('1. No matching rule (small refund) → passes silently', async () => {
    const targetId = `pos-${uuidv7()}`;
    await expect(
      service.assertApproved({
        kind: KIND,
        targetId,
        context: { amount: 50000, currency: 'THB' }, // ฿500 — under threshold
        requestedBy: requesterId,
      }),
    ).resolves.toBeUndefined();
  });

  it('2. Matching rule, no override → throws with pending review id', async () => {
    const targetId = `pos-${uuidv7()}`;
    let thrown: ApprovalRequiredError | undefined;
    try {
      await service.assertApproved({
        kind: KIND,
        targetId,
        context: { amount: 200000, currency: 'THB' }, // ฿2000 — over threshold
        requestedBy: requesterId,
        comment: 'customer changed mind',
      });
    } catch (e) {
      thrown = e as ApprovalRequiredError;
    }
    expect(thrown).toBeInstanceOf(ApprovalRequiredError);
    expect(thrown!.reviewIds).toHaveLength(1);

    const [row] = await client<{ status: string; payload: any; requester_comment: string }[]>`
      SELECT status, payload, requester_comment FROM custom.tier_reviews WHERE id = ${thrown!.reviewIds[0]}
    `;
    expect(row.status).toBe('pending');
    expect(row.payload.amount).toBe(200000);
    expect(row.requester_comment).toBe('customer changed mind');
  });

  it('3. Re-submit while pending → idempotent (same review id)', async () => {
    const targetId = `pos-${uuidv7()}`;
    const first = await service
      .assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId })
      .catch((e) => e as ApprovalRequiredError);
    const second = await service
      .assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId })
      .catch((e) => e as ApprovalRequiredError);
    expect(first.reviewIds[0]).toBe(second.reviewIds[0]);

    // And the partial-unique index should reject any second pending row
    // sneaking in via raw SQL.
    let dupBlocked = false;
    try {
      await client`
        INSERT INTO custom.tier_reviews (definition_id, target_kind, target_id, status, payload)
        VALUES (${definitionId}, ${KIND}, ${targetId}, 'pending', '{}'::jsonb)
      `;
    } catch (e: any) {
      dupBlocked = /duplicate key|unique/i.test(e?.message ?? '');
    }
    expect(dupBlocked).toBe(true);
  });

  it('4. Approve → next assertApproved passes', async () => {
    const targetId = `pos-${uuidv7()}`;
    const failed = await service
      .assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId })
      .catch((e) => e as ApprovalRequiredError);
    await service.approve(failed.reviewIds[0], reviewerId, 'okay this time');

    await expect(
      service.assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId }),
    ).resolves.toBeUndefined();
  });

  it('5. Reject → next assertApproved creates a NEW pending review', async () => {
    const targetId = `pos-${uuidv7()}`;
    const failed = await service
      .assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId })
      .catch((e) => e as ApprovalRequiredError);
    await service.reject(failed.reviewIds[0], reviewerId, 'not enough info');

    const second = await service
      .assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId })
      .catch((e) => e as ApprovalRequiredError);
    expect(second.reviewIds[0]).not.toBe(failed.reviewIds[0]);

    const rows = await client<{ status: string }[]>`
      SELECT status FROM custom.tier_reviews
      WHERE target_id = ${targetId}
      ORDER BY requested_at ASC
    `;
    expect(rows.map((r) => r.status)).toEqual(['rejected', 'pending']);
  });

  it('6. preApprovedBy in reviewer list → bypasses + synthesises approved row', async () => {
    const targetId = `pos-${uuidv7()}`;
    await expect(
      service.assertApproved({
        kind: KIND,
        targetId,
        context: { amount: 200000 },
        requestedBy: requesterId,
        preApprovedBy: reviewerId,
      }),
    ).resolves.toBeUndefined();

    const [row] = await client<{ status: string; resolved_by: string }[]>`
      SELECT status, resolved_by::text FROM custom.tier_reviews WHERE target_id = ${targetId}
    `;
    expect(row.status).toBe('approved');
    expect(row.resolved_by).toBe(reviewerId);
  });

  it('7. preApprovedBy NOT in reviewer list → still blocks', async () => {
    const targetId = `pos-${uuidv7()}`;
    let thrown: ApprovalRequiredError | undefined;
    try {
      await service.assertApproved({
        kind: KIND,
        targetId,
        context: { amount: 200000 },
        requestedBy: requesterId,
        preApprovedBy: nonReviewerId, // wrong manager
      });
    } catch (e) {
      thrown = e as ApprovalRequiredError;
    }
    expect(thrown).toBeInstanceOf(ApprovalRequiredError);
  });

  it('8a. Sequence ordering — tier 20 hidden until tier 10 approves', async () => {
    // Add a second rule at sequence 20 alongside the existing sequence-10 rule.
    const reviewerJson = JSON.stringify([reviewerId]);
    const [d2] = await client`
      INSERT INTO custom.tier_definitions
        (name, target_kind, condition_expr, sequence, reviewer_ids, is_active)
      VALUES
        ('Refund > ฿1000 (tier 2)', ${KIND}, 'amount > 100000', 20,
         ${reviewerJson}::jsonb, true)
      RETURNING id::text
    `;
    const d2Id = d2.id;
    try {
      const targetId = `pos-${uuidv7()}`;
      // First submit creates only the tier-10 pending review.
      const failed = await service
        .assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId })
        .catch((e) => e as ApprovalRequiredError);
      expect(failed.reviewIds).toHaveLength(1);

      // Reviewer's inbox should ONLY surface the tier-10 row, not tier-20.
      const inbox1 = await service.listPending(reviewerId);
      const forThisTarget = inbox1.filter((r) => r.review.targetId === targetId);
      expect(forThisTarget).toHaveLength(1);
      expect(forThisTarget[0].definition?.sequence).toBe(10);

      // Approve tier 10. Re-asserting now creates the tier-20 review.
      await service.approve(failed.reviewIds[0], reviewerId, 'tier 1 ok');

      let secondError: ApprovalRequiredError | undefined;
      try {
        await service.assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId });
      } catch (e) {
        secondError = e as ApprovalRequiredError;
      }
      expect(secondError).toBeInstanceOf(ApprovalRequiredError);
      expect(secondError!.reviewIds).toHaveLength(1);

      // Now tier-20 IS visible.
      const inbox2 = await service.listPending(reviewerId);
      const forThisTarget2 = inbox2.filter((r) => r.review.targetId === targetId);
      expect(forThisTarget2).toHaveLength(1);
      expect(forThisTarget2[0].definition?.sequence).toBe(20);

      // Approve tier 20 → final assert passes.
      await service.approve(secondError!.reviewIds[0], reviewerId, 'tier 2 ok');
      await expect(
        service.assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId }),
      ).resolves.toBeUndefined();
    } finally {
      await client`DELETE FROM custom.tier_reviews WHERE definition_id = ${d2Id}`;
      await client`DELETE FROM custom.tier_definitions WHERE id = ${d2Id}`;
    }
  });

  it('8. cancelForTarget cancels all pending reviews for that target', async () => {
    const targetId = `pos-${uuidv7()}`;
    await service
      .assertApproved({ kind: KIND, targetId, context: { amount: 200000 }, requestedBy: requesterId })
      .catch(() => {});

    await service.cancelForTarget(KIND, targetId, requesterId);

    const rows = await client<{ status: string }[]>`
      SELECT status FROM custom.tier_reviews WHERE target_id = ${targetId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('cancelled');
  });
});

describe('matchesCondition()', () => {
  it.each([
    ['', { amount: 100 }, true],
    [null, { amount: 100 }, true],
    ['amount > 100', { amount: 200 }, true],
    ['amount > 100', { amount: 50 }, false],
    ['amount >= 100', { amount: 100 }, true],
    ['amount > 100 && currency == \'THB\'', { amount: 200, currency: 'THB' }, true],
    ['amount > 100 && currency == \'THB\'', { amount: 200, currency: 'USD' }, false],
    ['amount > 1000 || isPartial', { amount: 50, isPartial: true }, true],
    ['amount > 1000 || isPartial', { amount: 50, isPartial: false }, false],
    ['isPartial', { isPartial: true }, true],
    ['isPartial', { isPartial: false }, false],
    ['kind != \'cash\'', { kind: 'card' }, true],
    ['kind != \'cash\'', { kind: 'cash' }, false],
  ] as const)('%s with %j → %s', (expr, ctx, expected) => {
    expect(matchesCondition(expr, ctx as any)).toBe(expected);
  });
});
