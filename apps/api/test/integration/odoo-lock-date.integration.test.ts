/**
 * Live-Odoo integration test for OCA `account_journal_lock_date` +
 * `account_lock_date_update` (`OCA/account-financial-tools`, branch 18.0).
 *
 * Why this matters:
 *   §86/3 + §83/1 require that once a tax-period return (PP.30, PND.x) is
 *   filed, no journal entry inside that period may be edited. Odoo core has
 *   a *company-wide* lock date; what we get from these two OCA modules is:
 *     - `fiscalyear_lock_date` + `period_lock_date` ON EACH JOURNAL — so we
 *       can lock the Sales journal after PP.30 filing without freezing
 *       payroll, bank, or AP work in the same month.
 *     - A wizard that lets the Adviser group (account.group_account_manager)
 *       update lock dates without full Settings access.
 *
 * The test exercises the live local Odoo container (does NOT use
 * testcontainers — Odoo bootstrap is too heavy for per-test isolation).
 * Skips gracefully if Odoo is unreachable.
 *
 * Prerequisites (ensure once before running):
 *   - docker compose up -d odoo
 *   - both modules installed (see CLAUDE.md "OCA period-lock activation")
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureRef = `lock-date-test-${Date.now()}`;

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
  'OCA account_journal_lock_date + account_lock_date_update (live Odoo)',
  () => {
    let testJournalId: number;
    let otherJournalId: number | null = null;
    let originalJournalLock: string | false = false;
    let originalJournalPeriodLock: string | false = false;
    let companyId: number;
    let originalCompanyLock: string | false = false;
    let debitAccountId: number;
    let creditAccountId: number;

    beforeAll(async () => {
      // 1. Authenticate
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      expect(auth?.uid).toBeGreaterThan(0);

      // 2. Both modules must be installed
      const mods = await odooCall(
        'ir.module.module',
        'search_read',
        [
          [
            ['name', 'in', ['account_journal_lock_date', 'account_lock_date_update']],
            ['state', '=', 'installed'],
          ],
        ],
        { fields: ['name'], limit: 5 },
      );
      expect(mods).toHaveLength(2);

      // 3. Get a misc/general journal (so we don't lock the customer-invoice path)
      const journals = await odooCall(
        'account.journal',
        'search_read',
        [[['code', '=', 'MISC']]],
        { fields: ['id', 'name', 'fiscalyear_lock_date', 'period_lock_date'], limit: 1 },
      );
      expect(journals).toHaveLength(1);
      testJournalId = journals[0].id;
      originalJournalLock = journals[0].fiscalyear_lock_date;
      originalJournalPeriodLock = journals[0].period_lock_date;

      // 4. Get a second general journal for cross-journal isolation test
      const others = await odooCall(
        'account.journal',
        'search_read',
        [
          [
            ['type', '=', 'general'],
            ['id', '!=', testJournalId],
            ['active', '=', true],
          ],
        ],
        { fields: ['id'], limit: 1 },
      );
      otherJournalId = others.length ? others[0].id : null;

      // 5. Save current company lock for restore
      const companies = await odooCall(
        'res.company',
        'search_read',
        [[]],
        { fields: ['id', 'fiscalyear_lock_date'], limit: 1 },
      );
      companyId = companies[0].id;
      originalCompanyLock = companies[0].fiscalyear_lock_date;

      // 6. Pick two accounts (any two suffice for a balanced JE)
      const accounts = await odooCall(
        'account.account',
        'search_read',
        [[['deprecated', '=', false]]],
        { fields: ['id', 'code', 'name'], order: 'code asc', limit: 2 },
      );
      expect(accounts).toHaveLength(2);
      debitAccountId = accounts[0].id;
      creditAccountId = accounts[1].id;
    });

    afterAll(async () => {
      // Always clear the locks we set, regardless of test outcome.
      if (testJournalId) {
        await odooCall('account.journal', 'write', [
          [testJournalId],
          {
            fiscalyear_lock_date: originalJournalLock || false,
            period_lock_date: originalJournalPeriodLock || false,
          },
        ]);
      }
      if (companyId) {
        await odooCall('res.company', 'write', [
          [companyId],
          { fiscalyear_lock_date: originalCompanyLock || false },
        ]);
      }
    });

    it('account_journal_lock_date adds fiscalyear_lock_date + period_lock_date to account.journal', async () => {
      const result = await odooCall(
        'account.journal',
        'fields_get',
        [['fiscalyear_lock_date', 'period_lock_date']],
        { attributes: ['type', 'string'] },
      );
      expect(result.fiscalyear_lock_date.type).toBe('date');
      expect(result.period_lock_date.type).toBe('date');
    });

    it('account_lock_date_update registers the wizard model account.update.lock_date', async () => {
      const count = await odooCall(
        'ir.model',
        'search_count',
        [[['model', '=', 'account.update.lock_date']]],
      );
      expect(count).toBe(1);

      // And the wizard exposes the 5 LOCK_DATE_FIELDS
      const fields = await odooCall(
        'account.update.lock_date',
        'fields_get',
        [
          [
            'fiscalyear_lock_date',
            'tax_lock_date',
            'sale_lock_date',
            'purchase_lock_date',
            'hard_lock_date',
          ],
        ],
        { attributes: ['type'] },
      );
      expect(fields.fiscalyear_lock_date.type).toBe('date');
      expect(fields.tax_lock_date.type).toBe('date');
      expect(fields.sale_lock_date.type).toBe('date');
      expect(fields.purchase_lock_date.type).toBe('date');
      expect(fields.hard_lock_date.type).toBe('date');
    });

    it('locked journal: posting a back-dated entry is blocked with a clear error', async () => {
      const lockDate = '2026-04-30';
      const backDated = '2026-04-15';

      // Set the journal-level lock
      await odooCall('account.journal', 'write', [
        [testJournalId],
        { fiscalyear_lock_date: lockDate },
      ]);

      // Verify the field landed
      const j = await odooCall(
        'account.journal',
        'read',
        [[testJournalId], ['fiscalyear_lock_date']],
      );
      expect(j[0].fiscalyear_lock_date).toBe(lockDate);

      // Create a draft move dated INSIDE the lock window
      const moveId = await odooCall('account.move', 'create', [
        {
          journal_id: testJournalId,
          date: backDated,
          ref: `${fixtureRef}-blocked`,
          line_ids: [
            [0, 0, {
              account_id: debitAccountId,
              debit: 100,
              credit: 0,
              name: 'lock test debit',
            }],
            [0, 0, {
              account_id: creditAccountId,
              debit: 0,
              credit: 100,
              name: 'lock test credit',
            }],
          ],
        },
      ]);
      expect(moveId).toBeGreaterThan(0);

      // Attempt to post — must fail with the OCA module's error message
      let blocked = false;
      let errorMessage = '';
      try {
        await odooCall('account.move', 'action_post', [[moveId]]);
      } catch (e) {
        blocked = true;
        errorMessage = (e as Error).message;
      }
      expect(blocked).toBe(true);
      expect(errorMessage).toMatch(/(lock date|prior to and inclusive)/i);

      // Confirm move is still draft
      const after = await odooCall(
        'account.move',
        'read',
        [[moveId], ['state']],
      );
      expect(after[0].state).toBe('draft');

      // Cleanup: drafts are deletable
      await odooCall('account.move', 'unlink', [[moveId]]);
    });

    it('locked journal: posting an entry AFTER the lock date succeeds', async () => {
      const lockDate = '2026-04-30';
      const futureDated = '2026-05-15';

      await odooCall('account.journal', 'write', [
        [testJournalId],
        { fiscalyear_lock_date: lockDate },
      ]);

      const moveId = await odooCall('account.move', 'create', [
        {
          journal_id: testJournalId,
          date: futureDated,
          ref: `${fixtureRef}-allowed`,
          line_ids: [
            [0, 0, {
              account_id: debitAccountId,
              debit: 50,
              credit: 0,
              name: 'after-lock debit',
            }],
            [0, 0, {
              account_id: creditAccountId,
              debit: 0,
              credit: 50,
              name: 'after-lock credit',
            }],
          ],
        },
      ]);

      await odooCall('account.move', 'action_post', [[moveId]]);

      const after = await odooCall(
        'account.move',
        'read',
        [[moveId], ['state']],
      );
      expect(after[0].state).toBe('posted');

      // Reset to draft + unlink so we don't leave noise in the books
      await odooCall('account.move', 'button_draft', [[moveId]]);
      await odooCall('account.move', 'unlink', [[moveId]]);
    });

    it('a different journal is NOT affected by the locked journal', async () => {
      if (otherJournalId === null) {
        // Only one general journal exists — skip this assertion
        console.warn('Only one general journal available; skipping cross-journal isolation test');
        return;
      }

      const lockDate = '2026-04-30';
      const backDated = '2026-04-15';

      // Re-apply lock on testJournalId
      await odooCall('account.journal', 'write', [
        [testJournalId],
        { fiscalyear_lock_date: lockDate },
      ]);
      // Ensure the OTHER journal has NO lock
      await odooCall('account.journal', 'write', [
        [otherJournalId],
        { fiscalyear_lock_date: false, period_lock_date: false },
      ]);

      const moveId = await odooCall('account.move', 'create', [
        {
          journal_id: otherJournalId,
          date: backDated,
          ref: `${fixtureRef}-cross-journal`,
          line_ids: [
            [0, 0, {
              account_id: debitAccountId,
              debit: 25,
              credit: 0,
              name: 'cross-journal debit',
            }],
            [0, 0, {
              account_id: creditAccountId,
              debit: 0,
              credit: 25,
              name: 'cross-journal credit',
            }],
          ],
        },
      ]);

      // Should post even though the date is BEFORE the OTHER journal's lock
      await odooCall('account.move', 'action_post', [[moveId]]);

      const after = await odooCall(
        'account.move',
        'read',
        [[moveId], ['state']],
      );
      expect(after[0].state).toBe('posted');

      await odooCall('account.move', 'button_draft', [[moveId]]);
      await odooCall('account.move', 'unlink', [[moveId]]);
    });

    it('clearing the lock date allows back-dated posting again', async () => {
      const lockDate = '2026-04-30';
      const backDated = '2026-04-15';

      // Lock first
      await odooCall('account.journal', 'write', [
        [testJournalId],
        { fiscalyear_lock_date: lockDate },
      ]);

      // Then unlock
      await odooCall('account.journal', 'write', [
        [testJournalId],
        { fiscalyear_lock_date: false, period_lock_date: false },
      ]);

      const moveId = await odooCall('account.move', 'create', [
        {
          journal_id: testJournalId,
          date: backDated,
          ref: `${fixtureRef}-unlocked`,
          line_ids: [
            [0, 0, {
              account_id: debitAccountId,
              debit: 10,
              credit: 0,
              name: 'unlocked debit',
            }],
            [0, 0, {
              account_id: creditAccountId,
              debit: 0,
              credit: 10,
              name: 'unlocked credit',
            }],
          ],
        },
      ]);

      await odooCall('account.move', 'action_post', [[moveId]]);

      const after = await odooCall(
        'account.move',
        'read',
        [[moveId], ['state']],
      );
      expect(after[0].state).toBe('posted');

      await odooCall('account.move', 'button_draft', [[moveId]]);
      await odooCall('account.move', 'unlink', [[moveId]]);
    });
  },
);
