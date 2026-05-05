/**
 * REAL behaviour test for gap #9 — bank reconcile rule actually matches an
 * imported OFX line against an open customer invoice.
 *
 * The earlier #9 test (odoo-account-reconcile.integration.test.ts) only
 * proved rules can be CONFIGURED. This test proves they actually MATCH.
 *
 * Scenario:
 *   1. Create a test customer ACME Co.
 *   2. Issue customer invoice with payment_reference 'INV-2026-001' for $5,000
 *   3. Post the invoice → invoice is in 'posted' state, payment_state='not_paid'
 *   4. Configure BNK1 journal with res.partner.bank acct_number=1234567890
 *   5. Create an account.reconcile.model rule:
 *        rule_type=invoice_matching, match_label=match_regex,
 *        match_label_param='INV-[0-9]{4}-[0-9]{3}', auto_reconcile=True
 *   6. Generate OFX file with one CREDIT line: $5,000 / memo 'INV-2026-001 PAYMENT'
 *   7. Import the OFX → bank statement created with one line
 *   8. ASSERT: the bank statement line is `is_reconciled=True`
 *      AND the invoice's payment_state is now 'paid' (or 'in_payment')
 *
 * If the rule didn't match, the line would remain unreconciled — the test
 * fails honestly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `recon-real-${Date.now()}`;
// Account number must be unique per run. Odoo blocks creating a
// res.partner.bank if any record (including archived) has the same
// acc_number for the same partner. We salt with last 7 digits of
// Date.now() to keep within typical bank account length.
const TEST_ACCT = `987${String(Date.now()).slice(-7)}`;
const INVOICE_REF = `INV-2026-001`;

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

function buildOfx(): string {
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:103',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20260601000000</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<TRNUID>1</TRNUID>',
    '<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS>',
    '<CURDEF>USD</CURDEF>',
    '<BANKACCTFROM>',
    '<BANKID>123456789</BANKID>',
    `<ACCTID>${TEST_ACCT}</ACCTID>`,
    '<ACCTTYPE>CHECKING</ACCTTYPE>',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    '<DTSTART>20260601000000</DTSTART>',
    '<DTEND>20260615000000</DTEND>',
    '<STMTTRN>',
    '<TRNTYPE>CREDIT</TRNTYPE>',
    '<DTPOSTED>20260605000000</DTPOSTED>',
    '<TRNAMT>5000.00</TRNAMT>',
    `<FITID>${fixtureTag}-001</FITID>`,
    `<NAME>${INVOICE_REF} PAYMENT</NAME>`,
    '</STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>5000.00</BALAMT><DTASOF>20260615000000</DTASOF></LEDGERBAL>',
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
  ].join('\r\n');
}

describe.runIf(await odooReachable())(
  'OCA reconcile rule REAL match (live Odoo, gap-fill #9)',
  () => {
    let bankJournalId = 0;
    let originalBankAccountId: number | false = false;
    let testPartnerBankId = 0;
    let customerId = 0;
    let invoiceId = 0;
    let ruleId = 0;
    let createdStatementIds: number[] = [];

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      expect(auth?.uid).toBeGreaterThan(0);

      // Find bank journal + sale journal + income account
      const bankJournals = await odooCall('account.journal', 'search_read',
        [[['type', '=', 'bank']]],
        { fields: ['id', 'bank_account_id'], limit: 1 });
      bankJournalId = bankJournals[0].id;
      originalBankAccountId = bankJournals[0].bank_account_id ? bankJournals[0].bank_account_id[0] : false;

      const saleJournals = await odooCall('account.journal', 'search_read',
        [[['type', '=', 'sale']]],
        { fields: ['id'], limit: 1 });
      const saleJournalId = saleJournals[0].id as number;

      const incomeAccts = await odooCall('account.account', 'search_read',
        [[['account_type', '=', 'income']]],
        { fields: ['id'], limit: 1 });
      const incomeAccountId = incomeAccts[0].id as number;

      const companies = await odooCall('res.company', 'search_read', [[]],
        { fields: ['partner_id'], limit: 1 });
      const companyPartnerId = companies[0].partner_id[0] as number;

      // 1. Create test customer
      customerId = await odooCall('res.partner', 'create', [
        { name: `${fixtureTag}-acme`, customer_rank: 1, is_company: true },
      ]);

      // 2. Create + post a customer invoice $5000 with payment_reference INV-2026-001
      invoiceId = await odooCall('account.move', 'create', [
        {
          move_type: 'out_invoice',
          partner_id: customerId,
          journal_id: saleJournalId,
          payment_reference: INVOICE_REF,
          invoice_date: '2026-06-01',
          invoice_line_ids: [
            [0, 0, {
              name: 'Service for May 2026',
              account_id: incomeAccountId,
              quantity: 1,
              price_unit: 5000.0,
              tax_ids: [[6, 0, []]], // no tax
            }],
          ],
        },
      ]);
      await odooCall('account.move', 'action_post', [[invoiceId]]);

      // 3. Set up the bank account on BNK1 for the OFX matching
      testPartnerBankId = await odooCall('res.partner.bank', 'create', [
        { acc_number: TEST_ACCT, partner_id: companyPartnerId },
      ]);
      await odooCall('account.journal', 'write', [
        [bankJournalId],
        { bank_account_id: testPartnerBankId },
      ]);

      // 4. Create the auto-reconcile rule
      ruleId = await odooCall('account.reconcile.model', 'create', [
        {
          name: `${fixtureTag}-rule`,
          rule_type: 'invoice_matching',
          match_label: 'match_regex',
          match_label_param: 'INV-[0-9]{4}-[0-9]{3}',
          auto_reconcile: true,
          match_partner: false,
          sequence: 5,
        },
      ]);
    });

    afterAll(async () => {
      // Restore + delete in dependency order
      if (bankJournalId) {
        try {
          await odooCall('account.journal', 'write',
            [[bankJournalId], { bank_account_id: originalBankAccountId || false }]);
        } catch (e) { /* */ }
      }
      // Statements + lines
      for (const sid of createdStatementIds) {
        try {
          const lineIds = await odooCall('account.bank.statement.line', 'search',
            [[['statement_id', '=', sid]]]);
          if (lineIds.length) {
            // Lines may be reconciled — try unlinking; if it fails we'll silently move on
            try {
              await odooCall('account.bank.statement.line', 'unlink', [lineIds]);
            } catch {}
          }
          await odooCall('account.bank.statement', 'unlink', [[sid]]);
        } catch (e) { /* */ }
      }
      if (testPartnerBankId) {
        try { await odooCall('res.partner.bank', 'unlink', [[testPartnerBankId]]); } catch {}
      }
      if (ruleId) {
        try { await odooCall('account.reconcile.model', 'unlink', [[ruleId]]); } catch {}
      }
      // Invoice + customer last (after their reconciliations are gone)
      if (invoiceId) {
        try {
          await odooCall('account.move', 'button_draft', [[invoiceId]]);
          await odooCall('account.move', 'button_cancel', [[invoiceId]]);
          await odooCall('account.move', 'unlink', [[invoiceId]]);
        } catch {}
      }
      if (customerId) {
        // res.partner can't be unlinked when audit logs / mail follower
        // records reference it. Archive instead — idempotent.
        try { await odooCall('res.partner', 'write', [[customerId], { active: false }]); } catch {}
      }
    });

    it('setup: invoice posted with payment_reference INV-2026-001 for $5000', async () => {
      const [inv] = await odooCall('account.move', 'read',
        [[invoiceId], ['state', 'payment_reference', 'amount_total', 'payment_state']]);
      expect(inv.state).toBe('posted');
      expect(inv.payment_reference).toBe(INVOICE_REF);
      expect(inv.amount_total).toBeCloseTo(5000, 2);
      expect(inv.payment_state).toBe('not_paid'); // before reconciliation
    });

    it('setup: rule configured with regex auto_reconcile=true', async () => {
      const [r] = await odooCall('account.reconcile.model', 'read',
        [[ruleId], ['rule_type', 'match_label', 'match_label_param', 'auto_reconcile']]);
      expect(r.rule_type).toBe('invoice_matching');
      expect(r.match_label).toBe('match_regex');
      expect(r.match_label_param).toBe('INV-[0-9]{4}-[0-9]{3}');
      expect(r.auto_reconcile).toBe(true);
    });

    it('REAL: import OFX with INV-2026-001 memo, line gets auto-reconciled to the invoice', async () => {
      const ofxBase64 = Buffer.from(buildOfx(), 'utf-8').toString('base64');

      const wizardId = await odooCall('account.statement.import', 'create', [
        {
          statement_file: ofxBase64,
          statement_filename: `${fixtureTag}.ofx`,
        },
      ]);

      const action = await odooCall(
        'account.statement.import',
        'import_file_button',
        [[wizardId]],
      );

      // Extract statement IDs from the action
      let statementIds: number[] = [];
      const inner = (action as any)?.params?.next ?? action;
      const domain = inner?.domain ?? [];
      for (const clause of domain) {
        if (Array.isArray(clause) && clause[0] === 'id' && clause[1] === 'in') {
          statementIds = clause[2] as number[];
        }
      }
      expect(statementIds.length).toBe(1);
      createdStatementIds = statementIds;

      // Read the bank line + assert is_reconciled
      const lines = await odooCall('account.bank.statement.line', 'search_read',
        [[['statement_id', '=', statementIds[0]]]],
        { fields: ['id', 'amount', 'payment_ref', 'is_reconciled', 'amount_residual', 'partner_id'] });
      expect(lines.length).toBe(1);
      const line = lines[0];
      expect(line.amount).toBeCloseTo(5000, 2);
      expect(String(line.payment_ref)).toContain(INVOICE_REF);

      // ⭐ The load-bearing assertion: the line was auto-reconciled
      expect(line.is_reconciled).toBe(true);
      expect(line.amount_residual).toBeCloseTo(0, 2);
    });

    it('REAL: invoice payment_state flipped to paid (or in_payment)', async () => {
      const [inv] = await odooCall('account.move', 'read',
        [[invoiceId], ['payment_state', 'amount_residual']]);
      // Either 'paid' or 'in_payment' is a successful match — depends on
      // whether the bank statement line's move is posted vs draft
      expect(['paid', 'in_payment']).toContain(inv.payment_state);
      expect(inv.amount_residual).toBeCloseTo(0, 2);
    });
  },
);
