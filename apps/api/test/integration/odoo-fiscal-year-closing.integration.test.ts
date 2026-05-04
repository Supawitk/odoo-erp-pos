/**
 * Live-Odoo integration test for OCA `account_fiscal_year_closing`
 * (`OCA/account-closing`, branch 18.0.1.0.0).
 *
 * Why this matters:
 *   At Thai FY-end (typically 31 Dec) the accountant must:
 *     1. Close out P&L accounts (revenue + expense) into Current Year
 *        Earnings → which is the "result" line on PND.50.
 *     2. Generate opening JEs for the new fiscal year (Balance Sheet
 *        accounts only; P&L starts at zero).
 *   Doing this manually is hours of journal entries. This module supplies the
 *   wizard + a state-machine (draft → calculated → posted → cancelled) and
 *   guards: cannot delete unless draft/cancelled, cannot calculate while
 *   draft moves exist in the period, etc.
 *
 * The test:
 *   1. Module + 14 expected models + 2 inherited account.move fields exist
 *   2. State-machine values match
 *   3. A real closing record can be created → calculated → cancelled → unlinked
 *   4. The unlink() guard rejects deletion when state ∉ {draft, cancelled}
 *   5. The draft_moves_check() guard fires when there's a draft move in
 *      the period (and stays silent when there isn't)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `fyc-test-${Date.now()}`;

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
  'OCA account_fiscal_year_closing (live Odoo)',
  () => {
    let companyId = 0;
    let miscJournalId = 0;
    let closingId = 0;
    let draftMoveId = 0;
    // Use a *very* old year so any pre-existing data on this Odoo doesn't
    // collide (the model has UNIQUE(year, company_id)). 2020 is older than
    // any of our seeded test data.
    const closingYear = 2020;
    const closingYearStart = `${closingYear}-01-01`;
    const closingYearEnd = `${closingYear}-12-31`;
    const openingDate = `${closingYear + 1}-01-01`;

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      expect(auth?.uid).toBeGreaterThan(0);

      const companies = await odooCall(
        'res.company',
        'search_read',
        [[]],
        { fields: ['id'], limit: 1 },
      );
      companyId = companies[0].id;

      const misc = await odooCall(
        'account.journal',
        'search_read',
        [[['code', '=', 'MISC']]],
        { fields: ['id'], limit: 1 },
      );
      miscJournalId = misc[0].id;

      // Defensive: if a previous run leaked a 2020 closing or any 2020-dated
      // draft/posted moves with our fixture tag, clean them up first.
      const existing = await odooCall(
        'account.fiscalyear.closing',
        'search',
        [[['year', '=', closingYear]]],
      );
      if (existing.length) {
        // Cancel + unlink defensively; ignore errors.
        for (const id of existing) {
          try {
            await odooCall('account.fiscalyear.closing', 'button_cancel', [[id]]);
          } catch {
            /* ignore */
          }
          try {
            await odooCall('account.fiscalyear.closing', 'unlink', [[id]]);
          } catch {
            /* ignore */
          }
        }
      }
      const stale = await odooCall(
        'account.move',
        'search',
        [[['ref', 'like', `${fixtureTag.slice(0, 4)}-%`]]],
      );
      for (const id of stale) {
        try {
          await odooCall('account.move', 'button_draft', [[id]]);
        } catch {
          /* already draft */
        }
        try {
          await odooCall('account.move', 'unlink', [[id]]);
        } catch {
          /* ignore */
        }
      }
    });

    afterAll(async () => {
      // Cleanup the closing record if it still exists
      if (closingId) {
        try {
          await odooCall('account.fiscalyear.closing', 'button_cancel', [[closingId]]);
        } catch {
          /* already cancelled or draft */
        }
        try {
          await odooCall('account.fiscalyear.closing', 'unlink', [[closingId]]);
        } catch {
          /* ignore */
        }
      }
      // And any test draft move
      if (draftMoveId) {
        try {
          await odooCall('account.move', 'button_draft', [[draftMoveId]]);
        } catch {
          /* */
        }
        try {
          await odooCall('account.move', 'unlink', [[draftMoveId]]);
        } catch {
          /* */
        }
      }
    });

    it('module is installed at 18.0.1.0.0', async () => {
      const mods = await odooCall(
        'ir.module.module',
        'search_read',
        [[['name', '=', 'account_fiscal_year_closing'], ['state', '=', 'installed']]],
        { fields: ['name', 'latest_version'] },
      );
      expect(mods.length).toBe(1);
      expect(mods[0].latest_version).toBe('18.0.1.0.0');
    });

    it('all 14 closing models registered (closing, config, mapping, type, template variants, abstracts, unbalanced wizard)', async () => {
      const models = await odooCall(
        'ir.model',
        'search_read',
        [[['model', 'like', 'account.fiscalyear.closing%']]],
        { fields: ['model'] },
      );
      const set = new Set(models.map((m: any) => m.model));
      const expected = [
        'account.fiscalyear.closing',
        'account.fiscalyear.closing.config',
        'account.fiscalyear.closing.mapping',
        'account.fiscalyear.closing.type',
        'account.fiscalyear.closing.template',
        'account.fiscalyear.closing.config.template',
        'account.fiscalyear.closing.mapping.template',
        'account.fiscalyear.closing.type.template',
        'account.fiscalyear.closing.abstract',
        'account.fiscalyear.closing.config.abstract',
        'account.fiscalyear.closing.mapping.abstract',
        'account.fiscalyear.closing.type.abstract',
        'account.fiscalyear.closing.unbalanced.move',
        'account.fiscalyear.closing.unbalanced.move.line',
      ];
      for (const m of expected) {
        expect(set.has(m), `missing model ${m}`).toBe(true);
      }
      expect(set.size).toBe(expected.length);
    });

    it('inherited fields fyc_id (m2o → account.fiscalyear.closing) + closing_type (selection) added to account.move', async () => {
      const fields = await odooCall(
        'ir.model.fields',
        'search_read',
        [[['model', '=', 'account.move'], ['name', 'in', ['fyc_id', 'closing_type']]]],
        { fields: ['name', 'ttype', 'relation'] },
      );
      const byName = Object.fromEntries(fields.map((f: any) => [f.name, f]));
      expect(byName.fyc_id?.ttype).toBe('many2one');
      expect(byName.fyc_id?.relation).toBe('account.fiscalyear.closing');
      expect(byName.closing_type?.ttype).toBe('selection');
    });

    it('state machine has the 4 expected values: draft / calculated / posted / cancelled', async () => {
      const fields = await odooCall(
        'account.fiscalyear.closing',
        'fields_get',
        [['state']],
        { attributes: ['type', 'selection'] },
      );
      const states = (fields.state.selection as Array<[string, string]>).map(([k]) => k);
      expect(states.sort()).toEqual(['cancelled', 'calculated', 'draft', 'posted'].sort());
    });

    it('creates a closing record for the test year + computes derived dates', async () => {
      closingId = await odooCall('account.fiscalyear.closing', 'create', [
        {
          year: closingYear,
          date_start: closingYearStart,
          date_end: closingYearEnd,
          date_opening: openingDate,
          name: `${closingYear}`,
          company_id: companyId,
          check_draft_moves: false,
        },
      ]);
      expect(closingId).toBeGreaterThan(0);

      const [closing] = await odooCall(
        'account.fiscalyear.closing',
        'read',
        [[closingId], ['year', 'date_start', 'date_end', 'date_opening', 'state']],
      );
      expect(closing.year).toBe(closingYear);
      expect(closing.date_start).toBe(closingYearStart);
      expect(closing.date_end).toBe(closingYearEnd);
      expect(closing.date_opening).toBe(openingDate);
      expect(closing.state).toBe('draft');
    });

    it('UNIQUE(year, company_id): cannot create a second closing for the same year', async () => {
      let blocked = false;
      let errorMessage = '';
      try {
        await odooCall('account.fiscalyear.closing', 'create', [
          {
            year: closingYear,
            date_start: closingYearStart,
            date_end: closingYearEnd,
            date_opening: openingDate,
            name: `${closingYear}-dup`,
            company_id: companyId,
            check_draft_moves: false,
          },
        ]);
      } catch (e) {
        blocked = true;
        errorMessage = (e as Error).message;
      }
      expect(blocked).toBe(true);
      expect(errorMessage).toMatch(/(only one|unique|duplicate|already exists)/i);
    });

    it('unlink() is blocked while state ∈ {calculated, posted}', async () => {
      // Move to calculated state
      await odooCall('account.fiscalyear.closing', 'button_calculate', [[closingId]]);

      const [after] = await odooCall(
        'account.fiscalyear.closing',
        'read',
        [[closingId], ['state']],
      );
      expect(after.state).toBe('calculated');

      let blocked = false;
      let errorMessage = '';
      try {
        await odooCall('account.fiscalyear.closing', 'unlink', [[closingId]]);
      } catch (e) {
        blocked = true;
        errorMessage = (e as Error).message;
      }
      expect(blocked).toBe(true);
      expect(errorMessage).toMatch(/(can't remove|cannot remove|draft or cancelled|in draft)/i);
    });

    it('button_cancel transitions calculated → cancelled, then unlink succeeds', async () => {
      await odooCall('account.fiscalyear.closing', 'button_cancel', [[closingId]]);
      const [after] = await odooCall(
        'account.fiscalyear.closing',
        'read',
        [[closingId], ['state']],
      );
      expect(after.state).toBe('cancelled');

      await odooCall('account.fiscalyear.closing', 'unlink', [[closingId]]);
      // After successful unlink, mark as cleaned so afterAll doesn't double-delete
      const exists = await odooCall(
        'account.fiscalyear.closing',
        'search_count',
        [[['id', '=', closingId]]],
      );
      expect(exists).toBe(0);
      closingId = 0;
    });

    it('draft_moves_check raises ValidationError when a draft move exists in the closing period', async () => {
      // Find any two non-deprecated accounts to build a balanced draft JE
      const accounts = await odooCall(
        'account.account',
        'search_read',
        [[['deprecated', '=', false]]],
        { fields: ['id'], limit: 2, order: 'code asc' },
      );
      expect(accounts.length).toBe(2);

      // Create a draft move dated INSIDE the closing year
      draftMoveId = await odooCall('account.move', 'create', [
        {
          journal_id: miscJournalId,
          date: `${closingYear}-06-15`,
          ref: `${fixtureTag}-draft-in-period`,
          line_ids: [
            [0, 0, {
              account_id: accounts[0].id,
              debit: 5,
              credit: 0,
              name: 'fyc draft check debit',
            }],
            [0, 0, {
              account_id: accounts[1].id,
              debit: 0,
              credit: 5,
              name: 'fyc draft check credit',
            }],
          ],
        },
      ]);
      expect(draftMoveId).toBeGreaterThan(0);

      // Re-create a closing for the same year, this time with check_draft_moves=true
      closingId = await odooCall('account.fiscalyear.closing', 'create', [
        {
          year: closingYear,
          date_start: closingYearStart,
          date_end: closingYearEnd,
          date_opening: openingDate,
          name: `${closingYear}-with-check`,
          company_id: companyId,
          check_draft_moves: true,
        },
      ]);

      // button_calculate should fire draft_moves_check and raise
      let blocked = false;
      let errorMessage = '';
      try {
        await odooCall('account.fiscalyear.closing', 'button_calculate', [[closingId]]);
      } catch (e) {
        blocked = true;
        errorMessage = (e as Error).message;
      }
      expect(blocked).toBe(true);
      expect(errorMessage).toMatch(/draft moves? found/i);

      // Cleanup the draft move + closing
      await odooCall('account.move', 'unlink', [[draftMoveId]]);
      draftMoveId = 0;
      await odooCall('account.fiscalyear.closing', 'unlink', [[closingId]]);
      closingId = 0;
    });

    it('with no draft moves in period, calculate succeeds and state transitions to calculated', async () => {
      closingId = await odooCall('account.fiscalyear.closing', 'create', [
        {
          year: closingYear,
          date_start: closingYearStart,
          date_end: closingYearEnd,
          date_opening: openingDate,
          name: `${closingYear}-clean`,
          company_id: companyId,
          check_draft_moves: true,
        },
      ]);

      // No draft moves remaining in period
      await odooCall('account.fiscalyear.closing', 'button_calculate', [[closingId]]);
      const [after] = await odooCall(
        'account.fiscalyear.closing',
        'read',
        [[closingId], ['state']],
      );
      expect(after.state).toBe('calculated');

      // Cleanup
      await odooCall('account.fiscalyear.closing', 'button_cancel', [[closingId]]);
      await odooCall('account.fiscalyear.closing', 'unlink', [[closingId]]);
      closingId = 0;
    });
  },
);
