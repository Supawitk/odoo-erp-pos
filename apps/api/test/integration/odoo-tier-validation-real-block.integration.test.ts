/**
 * REAL behaviour test for gap #6 — tier validation actually blocks a state
 * transition until the reviewer approves.
 *
 * The earlier #6 test only proved tier.definition records persist and the
 * helper find_reviewer_level() returns the right user. This test proves
 * the actual workflow: try to confirm → blocked → approve → unblocked.
 *
 * Setup uses a custom test addon (odoo/custom-addons/test_tier_demo) which
 * defines a `tier.test.record` model that inherits the `tier.validation`
 * mixin with _state_from=['draft'], _state_to=['confirmed'].
 *
 * Scenario:
 *   1. Create tier.definition for tier.test.record, reviewer=admin
 *   2. Create a tier.test.record (state='draft', need_validation=True)
 *   3. Call request_validation() → review created, status='pending'
 *   4. Try action_confirm() (writes state='confirmed') → ValidationError
 *      "A validation process is still open"
 *   5. State remains 'draft'
 *   6. Call validate_tier() as admin → review.status='approved'
 *   7. Try action_confirm() again → SUCCEEDS, state='confirmed'
 *
 * If the engine were broken, either step 4 wouldn't block (false positive)
 * or step 7 wouldn't succeed (false negative).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `tier-real-${Date.now()}`;

let sessionCookie = '';

async function rpc(endpoint: string, params: unknown): Promise<any> {
  const r = await fetch(`${ODOO_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'call', params }),
  });
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/session_id=[^;]+/);
    if (m) sessionCookie = m[0];
  }
  const data = await r.json();
  if (data.error) {
    const msg =
      data.error.data?.message ??
      data.error.message ??
      JSON.stringify(data.error);
    throw new Error(String(msg));
  }
  return data.result;
}

async function odooCall(
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {},
): Promise<any> {
  return rpc('/web/dataset/call_kw', { model, method, args, kwargs });
}

async function odooReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${ODOO_URL}/web/database/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {} }),
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

describe.runIf(await odooReachable())(
  'OCA tier_validation REAL workflow (gap-fill #6)',
  () => {
    let adminUserId = 0;
    let testModelId = 0;
    let definitionId = 0;
    let recordId = 0;

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      adminUserId = auth?.uid as number;
      expect(adminUserId).toBeGreaterThan(0);

      // tier.test.record's ir.model row
      const models = await odooCall('ir.model', 'search_read',
        [[['model', '=', 'tier.test.record']]],
        { fields: ['id'], limit: 1 });
      expect(models).toHaveLength(1);
      testModelId = models[0].id as number;
    });

    afterAll(async () => {
      if (recordId) {
        try { await odooCall('tier.test.record', 'unlink', [[recordId]]); } catch {}
      }
      if (definitionId) {
        try { await odooCall('tier.definition', 'unlink', [[definitionId]]); } catch {}
      }
    });

    it('test_tier_demo (the consumer addon) is installed and tier.test.record model registered', async () => {
      const [m] = await odooCall('ir.module.module', 'search_read',
        [[['name', '=', 'test_tier_demo'], ['state', '=', 'installed']]],
        { fields: ['latest_version'] });
      // We bump the version when we iterate the addon — accept any 18.0.x.x.x.
      expect(String(m.latest_version)).toMatch(/^18\.0\./);
      expect(testModelId).toBeGreaterThan(0);
    });

    it('creates a tier.definition: reviewer=admin, sequence=10, applies-always', async () => {
      // Note: definition_type controls *when* the tier applies (domain /
      // formula / domain_formula), NOT the approval action. With
      // definition_type='domain' and an empty definition_domain, the rule
      // applies to every record.
      definitionId = await odooCall('tier.definition', 'create', [
        {
          name: `${fixtureTag}-def`,
          model_id: testModelId,
          definition_type: 'domain',
          definition_domain: '[]',
          review_type: 'individual',
          reviewer_id: adminUserId,
          sequence: 10,
          approve_sequence: false,
        },
      ]);
      expect(definitionId).toBeGreaterThan(0);
    });

    it('creates a tier.test.record (state=draft) with need_validation=True', async () => {
      recordId = await odooCall('tier.test.record', 'create', [
        { name: `${fixtureTag}-record`, amount: 1000.0 },
      ]);
      expect(recordId).toBeGreaterThan(0);

      const [rec] = await odooCall('tier.test.record', 'read',
        [[recordId], ['state', 'need_validation', 'review_ids']]);
      expect(rec.state).toBe('draft');
      expect(rec.review_ids).toEqual([]);
      expect(rec.need_validation).toBe(true); // no reviews yet, tier exists, in _state_from
    });

    it('REAL: request_validation() creates a tier.review row in pending state', async () => {
      await odooCall('tier.test.record', 'request_validation', [[recordId]]);

      const [rec] = await odooCall('tier.test.record', 'read',
        [[recordId], ['review_ids', 'need_validation', 'validation_status']]);
      expect(rec.review_ids.length).toBe(1);
      // After reviews exist, need_validation flips false (the work is now in-flight, not "needs to start")
      expect(rec.need_validation).toBe(false);
      expect(rec.validation_status).toBe('pending');

      const [review] = await odooCall('tier.review', 'read',
        [rec.review_ids, ['status', 'definition_id', 'reviewer_ids', 'can_review']]);
      expect(review.status).toBe('pending');
      expect(review.definition_id[0]).toBe(definitionId);
      // reviewer_ids is many2many — admin should be in there since
      // tier.definition.reviewer_id=admin
      const reviewerIds = review.reviewer_ids as number[];
      expect(reviewerIds).toContain(adminUserId);
      expect(review.can_review).toBe(true);
    });

    it('REAL: action_confirm() is BLOCKED while validation is pending (ValidationError)', async () => {
      let blocked = false;
      let errorMessage = '';
      try {
        await odooCall('tier.test.record', 'action_confirm', [[recordId]]);
      } catch (e) {
        blocked = true;
        errorMessage = (e as Error).message;
      }
      expect(blocked).toBe(true);
      expect(errorMessage).toMatch(/(validation process|needs to be validated|reviews pending)/i);

      // Verify the state DID NOT change
      const [rec] = await odooCall('tier.test.record', 'read',
        [[recordId], ['state']]);
      expect(rec.state).toBe('draft');
    });

    it('REAL: validate_tier() approves the review (status=approved, validation_status=validated)', async () => {
      await odooCall('tier.test.record', 'validate_tier', [[recordId]]);

      const [rec] = await odooCall('tier.test.record', 'read',
        [[recordId], ['validation_status', 'review_ids']]);
      expect(rec.validation_status).toBe('validated');

      const [review] = await odooCall('tier.review', 'read',
        [rec.review_ids, ['status']]);
      expect(review.status).toBe('approved');
    });

    it('REAL: action_confirm() now SUCCEEDS, state goes draft → confirmed', async () => {
      await odooCall('tier.test.record', 'action_confirm', [[recordId]]);

      const [rec] = await odooCall('tier.test.record', 'read',
        [[recordId], ['state']]);
      expect(rec.state).toBe('confirmed');
    });
  },
);
