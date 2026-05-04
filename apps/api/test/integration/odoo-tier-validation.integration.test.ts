/**
 * Live-Odoo integration test for the OCA tier-validation approval engine:
 *
 *   base_tier_validation          (OCA/server-ux 18.0.3.4.0 — Mature)
 *   base_tier_validation_formula  (OCA/server-ux 18.0.1.0.1 — Mature)
 *   l10n_th_tier_department       (OCA/l10n-thailand 18.0.1.0.1 — Alpha)
 *
 * Why this matters:
 *   Phase 4 needs multi-step approvals on refunds, voids, large POs, expense
 *   advances, and journal voids. The OCA engine supplies a generic
 *   "tier.validation" abstract mixin + a "tier.definition" config record + a
 *   "tier.review" runtime record. Specific consumer modules (e.g.
 *   account_invoice_tier_validation, purchase_tier_validation) wire the
 *   mixin onto their target model. The Thai add-on layers an HR-department
 *   approval ladder on top — so Phase 6 HR can drive who-approves-what from
 *   the org chart instead of hard-coded user lists.
 *
 * The test:
 *   1. Modules installed at expected upstream versions.
 *   2. Engine models registered (tier.definition + tier.review +
 *      tier.validation + tier.validation.exception) and the Thai add-on's
 *      tier.level model.
 *   3. Engine field surface: tier.definition has the canonical config
 *      fields (model_id, reviewer_id, sequence, definition_type,
 *      definition_domain).
 *   4. Formula module extended definition_type with "formula" + "domain_formula"
 *      and review_type with "expression"; added python_code +
 *      reviewer_expression text fields.
 *   5. l10n_th_tier_department added tier_level_ids one2many onto hr.department.
 *   6. End-to-end: create an HR department + two tier.level rows; verify
 *      find_reviewer_level(1) and (2) resolve to the right res.users.
 *   7. Create a tier.definition for account.move with a formula gate
 *      (amount_total > 10000) — verify it persists with the formula.
 *   8. Cleanup is fully idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `tier-test-${Date.now()}`;

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
  'OCA base_tier_validation + base_tier_validation_formula + l10n_th_tier_department (live Odoo)',
  () => {
    let adminUserId = 0;
    let testUserId = 0;
    let testDepartmentId = 0;
    let testLevelIds: number[] = [];
    let testDefinitionId = 0;
    let accountMoveModelId = 0;

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      adminUserId = auth?.uid as number;
      expect(adminUserId).toBeGreaterThan(0);

      // Find ir.model row for account.move (used as the example target of a
      // tier definition).
      const models = await odooCall(
        'ir.model',
        'search_read',
        [[['model', '=', 'account.move']]],
        { fields: ['id'], limit: 1 },
      );
      expect(models).toHaveLength(1);
      accountMoveModelId = models[0].id as number;

      // Create a 2nd test user we can use as the level-2 approver. Login is
      // unique per fixture run so the suite is idempotent.
      const internalGroup = await odooCall(
        'ir.model.data',
        'search_read',
        [[['module', '=', 'base'], ['name', '=', 'group_user']]],
        { fields: ['res_id'], limit: 1 },
      );
      const internalGroupId = internalGroup[0].res_id as number;

      testUserId = await odooCall('res.users', 'create', [
        {
          name: `${fixtureTag}-approver`,
          login: `${fixtureTag}-approver@test.local`,
          groups_id: [[6, 0, [internalGroupId]]],
        },
      ]);
      expect(testUserId).toBeGreaterThan(0);
    });

    afterAll(async () => {
      // Order matters: definition → levels → department → user.
      if (testDefinitionId) {
        try {
          await odooCall('tier.definition', 'unlink', [[testDefinitionId]]);
        } catch (e) {
          console.warn(`Could not unlink tier.definition ${testDefinitionId}: ${(e as Error).message}`);
        }
      }
      if (testLevelIds.length) {
        try {
          await odooCall('tier.level', 'unlink', [testLevelIds]);
        } catch (e) {
          console.warn(`Could not unlink tier.level ${testLevelIds}: ${(e as Error).message}`);
        }
      }
      if (testDepartmentId) {
        try {
          await odooCall('hr.department', 'unlink', [[testDepartmentId]]);
        } catch (e) {
          console.warn(`Could not unlink hr.department ${testDepartmentId}: ${(e as Error).message}`);
        }
      }
      if (testUserId) {
        try {
          // Resolve back to partner so we can clean it up too.
          const [u] = await odooCall(
            'res.users',
            'read',
            [[testUserId], ['partner_id']],
          );
          // Archive instead of unlink — Odoo blocks res.users.unlink when
          // any record references the user (audit logs, mail messages, etc.).
          await odooCall('res.users', 'write', [[testUserId], { active: false }]);
          if (u?.partner_id) {
            try {
              await odooCall('res.partner', 'write', [[u.partner_id[0]], { active: false }]);
            } catch {
              /* not critical */
            }
          }
        } catch (e) {
          console.warn(`Could not archive test user ${testUserId}: ${(e as Error).message}`);
        }
      }
    });

    it('all 3 modules installed at expected upstream versions', async () => {
      const mods = await odooCall(
        'ir.module.module',
        'search_read',
        [
          [
            [
              'name',
              'in',
              [
                'base_tier_validation',
                'base_tier_validation_formula',
                'l10n_th_tier_department',
              ],
            ],
            ['state', '=', 'installed'],
          ],
        ],
        { fields: ['name', 'latest_version'] },
      );
      const byName = Object.fromEntries(mods.map((m: any) => [m.name, m.latest_version]));
      expect(byName.base_tier_validation).toBe('18.0.3.4.0');
      expect(byName.base_tier_validation_formula).toBe('18.0.1.0.1');
      expect(byName.l10n_th_tier_department).toBe('18.0.1.0.1');
    });

    it('engine models registered: tier.definition + tier.review + tier.validation + tier.validation.exception + tier.level', async () => {
      const models = await odooCall(
        'ir.model',
        'search_read',
        [
          [
            [
              'model',
              'in',
              [
                'tier.definition',
                'tier.review',
                'tier.validation',
                'tier.validation.exception',
                'tier.level',
              ],
            ],
          ],
        ],
        { fields: ['model'] },
      );
      const set = new Set(models.map((m: any) => m.model));
      expect(set.size).toBe(5);
    });

    it('tier.definition has the canonical config field surface', async () => {
      const fields = await odooCall(
        'tier.definition',
        'fields_get',
        [
          [
            'name',
            'model_id',
            'reviewer_id',
            'reviewer_group_id',
            'sequence',
            'definition_type',
            'definition_domain',
            'review_type',
            'approve_sequence',
            'has_comment',
          ],
        ],
        { attributes: ['type', 'relation'] },
      );
      expect(fields.name?.type).toBe('char');
      expect(fields.model_id?.type).toBe('many2one');
      expect(fields.model_id?.relation).toBe('ir.model');
      expect(fields.reviewer_id?.type).toBe('many2one');
      expect(fields.reviewer_id?.relation).toBe('res.users');
      expect(fields.reviewer_group_id?.relation).toBe('res.groups');
      expect(fields.sequence?.type).toBe('integer');
      expect(fields.definition_type?.type).toBe('selection');
      expect(fields.definition_domain?.type).toBe('char');
      expect(fields.approve_sequence?.type).toBe('boolean');
    });

    it('formula module extended definition_type with formula + domain_formula and review_type with expression', async () => {
      const fields = await odooCall(
        'tier.definition',
        'fields_get',
        [['definition_type', 'review_type', 'python_code', 'reviewer_expression']],
        { attributes: ['type', 'selection'] },
      );

      const defKeys = (fields.definition_type.selection as Array<[string, string]>).map(([k]) => k);
      expect(defKeys).toContain('formula');
      expect(defKeys).toContain('domain_formula');

      const revKeys = (fields.review_type.selection as Array<[string, string]>).map(([k]) => k);
      expect(revKeys).toContain('expression');

      expect(fields.python_code?.type).toBe('text');
      expect(fields.reviewer_expression?.type).toBe('text');
    });

    it('l10n_th_tier_department added tier_level_ids one2many to hr.department', async () => {
      const fields = await odooCall(
        'hr.department',
        'fields_get',
        [['tier_level_ids']],
        { attributes: ['type', 'relation'] },
      );
      expect(fields.tier_level_ids?.type).toBe('one2many');
      expect(fields.tier_level_ids?.relation).toBe('tier.level');
    });

    it('end-to-end: create department with 2 tier levels and resolve approvers via find_reviewer_level()', async () => {
      // 1. Build the department + the two levels.
      testDepartmentId = await odooCall('hr.department', 'create', [
        { name: `${fixtureTag}-dept` },
      ]);
      expect(testDepartmentId).toBeGreaterThan(0);

      // tier.level requires user_id; level is computed from sequence.
      testLevelIds = await odooCall('tier.level', 'create', [
        [
          {
            department_id: testDepartmentId,
            user_id: adminUserId, // level 1
            sequence: 10,
            name: `${fixtureTag}-L1`,
          },
          {
            department_id: testDepartmentId,
            user_id: testUserId, // level 2
            sequence: 20,
            name: `${fixtureTag}-L2`,
          },
        ],
      ]);
      expect(testLevelIds.length).toBe(2);

      // Verify the one2many wiring.
      const [dept] = await odooCall(
        'hr.department',
        'read',
        [[testDepartmentId], ['tier_level_ids']],
      );
      expect(dept.tier_level_ids.length).toBe(2);

      // 2a. Verify the data shape directly via tier.level (sequence → user_id).
      const levels = await odooCall(
        'tier.level',
        'read',
        [testLevelIds, ['sequence', 'user_id']],
      );
      const sorted = levels.sort((a: any, b: any) => a.sequence - b.sequence);
      expect(sorted[0].user_id[0]).toBe(adminUserId);
      expect(sorted[1].user_id[0]).toBe(testUserId);

      // 2b. Exercise the OCA helper method find_reviewer_level(level=N).
      // JSON-RPC serialises Odoo recordsets as the repr "res.users(2,)" — we
      // parse the int out instead of using the recordset directly.
      const recordsetIdRegex = /res\.users\((\d+),?\)/;
      const lvl1 = await odooCall(
        'hr.department',
        'find_reviewer_level',
        [[testDepartmentId]],
        { level: 1 },
      );
      const lvl2 = await odooCall(
        'hr.department',
        'find_reviewer_level',
        [[testDepartmentId]],
        { level: 2 },
      );
      const lvl1Id = Number(String(lvl1).match(recordsetIdRegex)?.[1]);
      const lvl2Id = Number(String(lvl2).match(recordsetIdRegex)?.[1]);
      expect(lvl1Id).toBe(adminUserId);
      expect(lvl2Id).toBe(testUserId);

      // 2c. level=0 returns env.user (current user = admin in this session).
      const lvl0 = await odooCall(
        'hr.department',
        'find_reviewer_level',
        [[testDepartmentId]],
        { level: 0 },
      );
      const lvl0Id = Number(String(lvl0).match(recordsetIdRegex)?.[1]);
      expect(lvl0Id).toBe(adminUserId);
    });

    it('creates a tier.definition for account.move gated by a python formula', async () => {
      testDefinitionId = await odooCall('tier.definition', 'create', [
        {
          name: `${fixtureTag}-large-amount-gate`,
          model_id: accountMoveModelId,
          review_type: 'individual',
          reviewer_id: adminUserId,
          definition_type: 'formula',
          // The formula module evaluates `python_code` against the record.
          python_code: 'rec.amount_total > 10000',
          sequence: 30,
          approve_sequence: false,
          has_comment: true,
        },
      ]);
      expect(testDefinitionId).toBeGreaterThan(0);

      const [def] = await odooCall(
        'tier.definition',
        'read',
        [[testDefinitionId], ['model', 'definition_type', 'python_code', 'has_comment', 'sequence']],
      );
      expect(def.model).toBe('account.move');
      expect(def.definition_type).toBe('formula');
      expect(def.python_code).toBe('rec.amount_total > 10000');
      expect(def.has_comment).toBe(true);
      expect(def.sequence).toBe(30);
    });
  },
);
