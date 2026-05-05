/**
 * Live-Odoo integration test for the OCA account-reconcile stack:
 *
 *   account_statement_base       (OCA/account-reconcile 18.0.1.3.0)
 *   account_reconcile_model_oca  (OCA/account-reconcile 18.0.1.1.2)
 *   account_reconcile_oca        (OCA/account-reconcile 18.0.1.1.8)
 *   account_reconcile_oca_queue  (OCA/account-reconcile 18.0.1.1.0)
 *
 * Why this matters:
 *   Phase 4/5 needs bank reconciliation. Today we'd build matching ourselves.
 *   account_reconcile_model_oca *brings back the Enterprise reconcile.model
 *   logic into Community* — Odoo SA moved it to Enterprise in 17.0; OCA
 *   restored it in this module. account_reconcile_oca adds an OWL-based
 *   reconciliation widget. account_reconcile_oca_queue wires the
 *   auto-reconcile flow into queue_job so 5,000-line bank statements
 *   reconcile in the background with retry semantics.
 *
 * The test:
 *   1. All 4 modules installed at expected upstream versions.
 *   2. Models registered: account.reconcile.model + .line + bank.statement
 *      + bank.statement.line.
 *   3. rule_type selection has 3 values (writeoff_button, writeoff_suggestion,
 *      invoice_matching) — these are the kinds of rules an accountant
 *      configures.
 *   4. match_amount selection has 3 values (lower, greater, between).
 *   5. match_label selection has 3 values (contains, not_contains, match_regex)
 *      — rules can match by free-text and by regex against statement memo.
 *   6. account_reconcile_oca_queue extends res.company with
 *      account_auto_reconcile_queue boolean.
 *   7. End-to-end: create a real writeoff_suggestion rule + an invoice_matching
 *      rule, verify they persist and round-trip the regex/range/auto-reconcile
 *      configuration. Cleanup deletes only the rows we created.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `recon-test-${Date.now()}`;

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
  'OCA account_reconcile_oca + model_oca + oca_queue (live Odoo)',
  () => {
    let writeoffRuleId = 0;
    let matchingRuleId = 0;

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      expect(auth?.uid).toBeGreaterThan(0);
    });

    afterAll(async () => {
      // Idempotent: delete only the rules we created.
      const ids = [writeoffRuleId, matchingRuleId].filter((id) => id > 0);
      if (ids.length) {
        try {
          await odooCall('account.reconcile.model', 'unlink', [ids]);
        } catch (e) {
          console.warn(`Could not unlink reconcile rules ${ids}: ${(e as Error).message}`);
        }
      }
    });

    it('all 4 modules installed at expected upstream versions', async () => {
      const mods = await odooCall(
        'ir.module.module',
        'search_read',
        [
          [
            [
              'name',
              'in',
              [
                'account_statement_base',
                'account_reconcile_model_oca',
                'account_reconcile_oca',
                'account_reconcile_oca_queue',
              ],
            ],
            ['state', '=', 'installed'],
          ],
        ],
        { fields: ['name', 'latest_version'] },
      );
      const byName = Object.fromEntries(mods.map((m: any) => [m.name, m.latest_version]));
      expect(byName.account_statement_base).toBe('18.0.1.3.0');
      expect(byName.account_reconcile_model_oca).toBe('18.0.1.1.2');
      expect(byName.account_reconcile_oca).toBe('18.0.1.1.8');
      expect(byName.account_reconcile_oca_queue).toBe('18.0.1.1.0');
    });

    it('reconcile + bank-statement models registered', async () => {
      const models = await odooCall(
        'ir.model',
        'search_read',
        [
          [
            [
              'model',
              'in',
              [
                'account.reconcile.model',
                'account.reconcile.model.line',
                'account.bank.statement',
                'account.bank.statement.line',
              ],
            ],
          ],
        ],
        { fields: ['model'] },
      );
      const set = new Set(models.map((m: any) => m.model));
      expect(set.size).toBe(4);
    });

    it('rule_type selection: writeoff_button + writeoff_suggestion + invoice_matching', async () => {
      const fields = await odooCall(
        'account.reconcile.model',
        'fields_get',
        [['rule_type']],
        { attributes: ['selection'] },
      );
      const keys = (fields.rule_type.selection as Array<[string, string]>)
        .map(([k]) => k)
        .sort();
      expect(keys).toEqual(['invoice_matching', 'writeoff_button', 'writeoff_suggestion']);
    });

    it('match_amount selection: lower + greater + between', async () => {
      const fields = await odooCall(
        'account.reconcile.model',
        'fields_get',
        [['match_amount']],
        { attributes: ['selection'] },
      );
      const keys = (fields.match_amount.selection as Array<[string, string]>)
        .map(([k]) => k)
        .sort();
      expect(keys).toEqual(['between', 'greater', 'lower']);
    });

    it('match_label selection: contains + not_contains + match_regex', async () => {
      const fields = await odooCall(
        'account.reconcile.model',
        'fields_get',
        [['match_label']],
        { attributes: ['selection'] },
      );
      const keys = (fields.match_label.selection as Array<[string, string]>)
        .map(([k]) => k)
        .sort();
      expect(keys).toEqual(['contains', 'match_regex', 'not_contains']);
    });

    it('account_reconcile_oca_queue extended res.company with account_auto_reconcile_queue boolean', async () => {
      const fields = await odooCall(
        'res.company',
        'fields_get',
        [['account_auto_reconcile_queue']],
        { attributes: ['type'] },
      );
      expect(fields.account_auto_reconcile_queue?.type).toBe('boolean');
    });

    it('creates a writeoff_suggestion rule with regex match + amount range', async () => {
      writeoffRuleId = await odooCall('account.reconcile.model', 'create', [
        {
          name: `${fixtureTag}-writeoff-suggestion`,
          rule_type: 'writeoff_suggestion',
          match_label: 'match_regex',
          match_label_param: 'BANK FEE [0-9]+',
          match_amount: 'between',
          match_amount_min: 0.01,
          match_amount_max: 100.0,
          sequence: 50,
          auto_reconcile: false,
        },
      ]);
      expect(writeoffRuleId).toBeGreaterThan(0);

      const [r] = await odooCall(
        'account.reconcile.model',
        'read',
        [
          [writeoffRuleId],
          [
            'rule_type',
            'match_label',
            'match_label_param',
            'match_amount',
            'match_amount_min',
            'match_amount_max',
            'auto_reconcile',
          ],
        ],
      );
      expect(r.rule_type).toBe('writeoff_suggestion');
      expect(r.match_label).toBe('match_regex');
      expect(r.match_label_param).toBe('BANK FEE [0-9]+');
      expect(r.match_amount).toBe('between');
      expect(r.match_amount_min).toBeCloseTo(0.01, 4);
      expect(r.match_amount_max).toBeCloseTo(100.0, 2);
      expect(r.auto_reconcile).toBe(false);
    });

    it('creates an invoice_matching rule with auto_reconcile=true + match_partner=true', async () => {
      matchingRuleId = await odooCall('account.reconcile.model', 'create', [
        {
          name: `${fixtureTag}-invoice-matching`,
          rule_type: 'invoice_matching',
          match_label: 'contains',
          match_label_param: 'INV-',
          match_partner: true,
          auto_reconcile: true,
          sequence: 10,
        },
      ]);
      expect(matchingRuleId).toBeGreaterThan(0);

      const [r] = await odooCall(
        'account.reconcile.model',
        'read',
        [
          [matchingRuleId],
          [
            'rule_type',
            'match_label',
            'match_label_param',
            'match_partner',
            'auto_reconcile',
          ],
        ],
      );
      expect(r.rule_type).toBe('invoice_matching');
      expect(r.match_label).toBe('contains');
      expect(r.match_label_param).toBe('INV-');
      expect(r.match_partner).toBe(true);
      expect(r.auto_reconcile).toBe(true);
    });
  },
);
