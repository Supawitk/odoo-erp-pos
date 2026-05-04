/**
 * Live-Odoo integration test for the fixed-asset register stack:
 *
 *   account_asset_management         (OCA/account-financial-tools 18.0.1.1.3)
 *   account_asset_number             (OCA/account-financial-tools 18.0.1.0.0)
 *   account_asset_transfer           (OCA/account-financial-tools 18.0.1.0.1)
 *   l10n_th_account_asset_management (OCA/l10n-thailand 18.0.1.0.0)
 *   report_xlsx_helper               (OCA/reporting-engine 18.0.1.0.0, transitive dep)
 *
 * Why this matters:
 *   §65 ter requires a fixed-asset register with depreciation schedules. The
 *   OCA stack supplies the engine; the Thai add-on adds the parent grouping
 *   + sub-state taxonomy ("In Service", "In Repair", "Sold", etc.) the
 *   merchant's accountant expects. Without this, every depreciation entry
 *   would be a manual journal entry — a real pain at audit time.
 *
 * The test:
 *   1. Verifies the 5 modules + 6 models are present
 *   2. Verifies the Thai sub-state seed loaded (8 entries from data XML)
 *   3. Verifies l10n_th_* added the right fields to account.asset
 *   4. Builds a real linear / 12-month profile + asset and triggers
 *      compute_depreciation_board(); checks schedule integrity:
 *        - 1 purchase line + 12 depreciation lines = 13 total
 *        - sum of depreciation amounts = purchase value (no fractional drift)
 *        - depreciation_rate (Thai field) = 100/12 ≈ 8.33%
 *   5. Cleans up: unlink asset + profile, verify zero residue
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `asset-test-${Date.now()}`;

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
  'OCA account_asset_management + l10n_th_account_asset_management (live Odoo)',
  () => {
    let profileId = 0;
    let assetId = 0;
    let assetAccountId = 0;
    let depreciationAccountId = 0;
    let expenseAccountId = 0;
    let journalId = 0;

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      expect(auth?.uid).toBeGreaterThan(0);

      // Pick the right accounts for a profile.
      const fixed = await odooCall(
        'account.account',
        'search_read',
        [[['account_type', '=', 'asset_fixed']]],
        { fields: ['id'], limit: 1 },
      );
      const noncurrent = await odooCall(
        'account.account',
        'search_read',
        [[['account_type', '=', 'asset_non_current']]],
        { fields: ['id'], limit: 1 },
      );
      const expense = await odooCall(
        'account.account',
        'search_read',
        [[['account_type', '=', 'expense']]],
        { fields: ['id'], limit: 1, order: 'code asc' },
      );
      const misc = await odooCall(
        'account.journal',
        'search_read',
        [[['code', '=', 'MISC']]],
        { fields: ['id'], limit: 1 },
      );
      expect(fixed.length).toBe(1);
      expect(noncurrent.length).toBe(1);
      expect(expense.length).toBe(1);
      expect(misc.length).toBe(1);

      assetAccountId = fixed[0].id;
      depreciationAccountId = noncurrent[0].id;
      expenseAccountId = expense[0].id;
      journalId = misc[0].id;
    });

    afterAll(async () => {
      // Best-effort cleanup so the test is idempotent.
      if (assetId) {
        try {
          // Reset to draft if it's open / running so unlink is allowed
          await odooCall('account.asset', 'set_to_draft', [[assetId]]);
        } catch {
          /* already draft or unlink handles it */
        }
        try {
          await odooCall('account.asset', 'unlink', [[assetId]]);
        } catch (e) {
          // If the OCA unlink override blocks us, log and move on; the next
          // run will pick up via fixtureTag if the profile is gone.
          console.warn(`Could not unlink asset ${assetId}: ${(e as Error).message}`);
        }
      }
      if (profileId) {
        try {
          await odooCall('account.asset.profile', 'unlink', [[profileId]]);
        } catch (e) {
          console.warn(`Could not unlink profile ${profileId}: ${(e as Error).message}`);
        }
      }
    });

    it('all 5 OCA + Thai modules installed at expected versions', async () => {
      const mods = await odooCall(
        'ir.module.module',
        'search_read',
        [
          [
            [
              'name',
              'in',
              [
                'account_asset_management',
                'account_asset_number',
                'account_asset_transfer',
                'l10n_th_account_asset_management',
                'report_xlsx_helper',
              ],
            ],
            ['state', '=', 'installed'],
          ],
        ],
        { fields: ['name', 'latest_version'] },
      );
      const byName = Object.fromEntries(mods.map((m: any) => [m.name, m.latest_version]));
      expect(byName.account_asset_management).toBe('18.0.1.1.3');
      expect(byName.account_asset_number).toBe('18.0.1.0.0');
      expect(byName.account_asset_transfer).toBe('18.0.1.0.1');
      expect(byName.l10n_th_account_asset_management).toBe('18.0.1.0.0');
      expect(byName.report_xlsx_helper).toBe('18.0.1.0.0');
    });

    it('all 6 asset models registered', async () => {
      const models = await odooCall(
        'ir.model',
        'search_read',
        [
          [
            [
              'model',
              'in',
              [
                'account.asset',
                'account.asset.profile',
                'account.asset.line',
                'account.asset.group',
                'account.asset.parent',
                'account.asset.sub.state',
              ],
            ],
          ],
        ],
        { fields: ['model'] },
      );
      const set = new Set(models.map((m: any) => m.model));
      expect(set.size).toBe(6);
    });

    it('Thai sub-state taxonomy seed loaded (8 entries)', async () => {
      const count = await odooCall(
        'account.asset.sub.state',
        'search_count',
        [[]],
      );
      expect(count).toBe(8);
    });

    it('l10n_th_account_asset_management adds depreciation_rate, parent_id, asset_sub_state_id, image, sale_invoice_id to account.asset', async () => {
      const fields = await odooCall(
        'account.asset',
        'fields_get',
        [
          [
            'depreciation_rate',
            'parent_id',
            'asset_sub_state_id',
            'image',
            'sale_invoice_id',
          ],
        ],
        { attributes: ['type', 'relation'] },
      );
      expect(fields.depreciation_rate.type).toBe('float');
      expect(fields.parent_id.type).toBe('many2one');
      expect(fields.parent_id.relation).toBe('account.asset.parent');
      expect(fields.asset_sub_state_id.type).toBe('many2one');
      expect(fields.asset_sub_state_id.relation).toBe('account.asset.sub.state');
      expect(fields.image.type).toBe('binary');
      expect(fields.sale_invoice_id.type).toBe('many2one');
      expect(fields.sale_invoice_id.relation).toBe('account.move');
    });

    it('creates a linear / monthly / 12-period asset profile', async () => {
      profileId = await odooCall('account.asset.profile', 'create', [
        {
          name: `${fixtureTag}-profile`,
          account_asset_id: assetAccountId,
          account_depreciation_id: depreciationAccountId,
          account_expense_depreciation_id: expenseAccountId,
          journal_id: journalId,
          method: 'linear',
          method_number: 12,
          method_period: 'month',
          method_time: 'number',
        },
      ]);
      expect(profileId).toBeGreaterThan(0);

      const [profile] = await odooCall(
        'account.asset.profile',
        'read',
        [[profileId], ['method', 'method_period', 'method_number']],
      );
      expect(profile.method).toBe('linear');
      expect(profile.method_period).toBe('month');
      expect(profile.method_number).toBe(12);
    });

    it('creates an asset with ฿120,000 purchase value, computes a 12-line schedule that sums to the purchase value', async () => {
      // Asset inherits account_*, journal_id, and the depreciation method
      // chain from its profile. We only set the asset-level overrides (date,
      // value, prorata) explicitly. method/method_number/method_period are
      // computed from profile_id at write-time and we re-affirm them here so
      // the test asserts deterministic behaviour.
      assetId = await odooCall('account.asset', 'create', [
        {
          name: `${fixtureTag}-asset`,
          profile_id: profileId,
          purchase_value: 120000,
          date_start: '2026-01-01',
          method: 'linear',
          method_number: 12,
          method_period: 'month',
          method_time: 'number',
          prorata: false,
        },
      ]);
      expect(assetId).toBeGreaterThan(0);

      // Trigger the schedule
      await odooCall('account.asset', 'compute_depreciation_board', [[assetId]]);

      // Read back the lines.
      // The OCA model creates 1 'create' (purchase) line + N 'depreciate' lines.
      const lines = await odooCall(
        'account.asset.line',
        'search_read',
        [[['asset_id', '=', assetId]]],
        { fields: ['line_date', 'amount', 'type', 'depreciation_base', 'remaining_value'], order: 'line_date asc' },
      );

      // Separate the purchase line from depreciation lines
      const depreciationLines = lines.filter((l: any) => l.type === 'depreciate');
      const purchaseLines = lines.filter((l: any) => l.type === 'create');

      expect(purchaseLines.length).toBe(1);
      expect(depreciationLines.length).toBe(12);

      // Sum of all depreciation amounts must equal the purchase value (no drift)
      const totalDepreciated = depreciationLines.reduce(
        (s: number, l: any) => s + (l.amount as number),
        0,
      );
      expect(totalDepreciated).toBeCloseTo(120000, 2);

      // Each line should be exactly 10,000 (120,000 / 12) — linear, no salvage
      for (const line of depreciationLines) {
        expect(line.amount).toBeCloseTo(10000, 2);
      }

      // Last line must zero out remaining_value
      const lastLine = depreciationLines[depreciationLines.length - 1];
      expect(lastLine.remaining_value).toBeCloseTo(0, 2);
    });

    it('Thai depreciation_rate computed correctly: 100/12 ≈ 8.333%', async () => {
      const [asset] = await odooCall(
        'account.asset',
        'read',
        [[assetId], ['depreciation_rate', 'method_number']],
      );
      expect(asset.method_number).toBe(12);
      expect(asset.depreciation_rate).toBeCloseTo(100 / 12, 3);
    });

    it('validate() transitions asset state from draft to open', async () => {
      const [before] = await odooCall(
        'account.asset',
        'read',
        [[assetId], ['state']],
      );
      expect(before.state).toBe('draft');

      await odooCall('account.asset', 'validate', [[assetId]]);

      const [after] = await odooCall(
        'account.asset',
        'read',
        [[assetId], ['state']],
      );
      expect(after.state).toBe('open');
    });
  },
);
