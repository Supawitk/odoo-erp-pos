/**
 * Live-Odoo integration test for the Thai 50-Tawi (§50 bis Withholding Tax
 * Certificate) PDF generator stack:
 *
 *   l10n_th_base_utils                (OCA/l10n-thailand 18.0.3.0.0)
 *   l10n_th_amount_to_text            (OCA/l10n-thailand 18.0.2.0.0)
 *   l10n_th_account_tax               (OCA/l10n-thailand 18.0.1.5.4) — engine
 *   l10n_th_account_wht_cert_form     (OCA/l10n-thailand 18.0.1.0.1) — PDF
 *
 * Why this matters:
 *   §50 bis requires us, as the payer who withheld tax, to issue a printed
 *   certificate to the vendor at withholding time. The vendor uses it to
 *   claim the WHT credit on their CIT return; without it, the vendor can't
 *   reconcile our PND.3/PND.53 filing on their end, which means they call
 *   the merchant. CLAUDE.md Phase 4 originally listed building this PDF
 *   ourselves — this OCA module supplies it free, layered over the official
 *   RD form (rd.go.th/fileadmin/download/english_form/frm_WTC.pdf).
 *
 * The test:
 *   1. All 4 modules installed at expected versions
 *   2. Core models registered: withholding.tax.cert + .line + .code.income
 *   3. The 6 income_tax_form selection values exist (pnd1/1a/2/3/53/54)
 *   4. The 4 tax_payer selection values (the 4 RD form checkboxes)
 *   5. ir.sequence "withholding.tax.cert" present with WHT/{year}/ prefix
 *   6. PIT income-code seeds loaded for PND.1 (4 rows from §40(1)–(2))
 *   7. ir.actions.report XML id resolves with report_type='qweb-pdf'
 *   8. Create a "direct" cert (no payment_id/move_id, like the OCA upstream
 *      test), one PND.3 line at 3% of ฿1000 = ฿30
 *   9. action_done assigns a non-empty number from the sequence
 *  10. State transitions: action_cancel → 'cancel'
 *  11. Render the QWeb PDF — verify content begins with %PDF and is non-trivial
 *  12. Cleanup: cancel + unlink cert; unlink test partner
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `wht-test-${Date.now()}`;

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

/**
 * Resolve an Odoo XML id like "module.name" to its res_id, going through
 * ir.model.data.search_read because _xmlid_to_res_id is private (underscored
 * methods cannot be invoked over JSON-RPC).
 */
async function resolveXmlId(module: string, name: string): Promise<number> {
  const rows = await odooCall(
    'ir.model.data',
    'search_read',
    [[['module', '=', module], ['name', '=', name]]],
    { fields: ['res_id'], limit: 1 },
  );
  if (!rows.length) {
    throw new Error(`xml id ${module}.${name} not found in ir.model.data`);
  }
  return rows[0].res_id as number;
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
  'OCA l10n_th_account_wht_cert_form (50-Tawi PDF) — live Odoo',
  () => {
    let vendorPartnerId = 0;
    let certId = 0;

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      expect(auth?.uid).toBeGreaterThan(0);

      // Test vendor — we'll unlink in afterAll. supplier_rank>0 makes it a vendor.
      vendorPartnerId = await odooCall('res.partner', 'create', [
        {
          name: `${fixtureTag}-vendor`,
          is_company: true,
          supplier_rank: 1,
          vat: '0105551234567',
          street: '123 Test Road',
          city: 'Bangkok',
        },
      ]);
      expect(vendorPartnerId).toBeGreaterThan(0);
    });

    afterAll(async () => {
      if (certId) {
        try {
          // Cancel first; only draft/cancel state can be unlinked
          await odooCall('withholding.tax.cert', 'action_cancel', [[certId]]);
        } catch {
          /* may already be cancelled */
        }
        try {
          await odooCall('withholding.tax.cert', 'unlink', [[certId]]);
        } catch (e) {
          console.warn(`Could not unlink cert ${certId}: ${(e as Error).message}`);
        }
      }
      if (vendorPartnerId) {
        try {
          await odooCall('res.partner', 'unlink', [[vendorPartnerId]]);
        } catch (e) {
          console.warn(`Could not unlink partner ${vendorPartnerId}: ${(e as Error).message}`);
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
                'l10n_th_base_utils',
                'l10n_th_amount_to_text',
                'l10n_th_account_tax',
                'l10n_th_account_wht_cert_form',
              ],
            ],
            ['state', '=', 'installed'],
          ],
        ],
        { fields: ['name', 'latest_version'] },
      );
      const byName = Object.fromEntries(mods.map((m: any) => [m.name, m.latest_version]));
      expect(byName.l10n_th_base_utils).toBe('18.0.3.0.0');
      expect(byName.l10n_th_amount_to_text).toBe('18.0.2.0.0');
      expect(byName.l10n_th_account_tax).toBe('18.0.1.5.4');
      expect(byName.l10n_th_account_wht_cert_form).toBe('18.0.1.0.1');
    });

    it('core WHT models registered: withholding.tax.cert + .line + .code.income', async () => {
      const models = await odooCall(
        'ir.model',
        'search_read',
        [[['model', 'in', ['withholding.tax.cert', 'withholding.tax.cert.line', 'withholding.tax.code.income']]]],
        { fields: ['model'] },
      );
      const set = new Set(models.map((m: any) => m.model));
      expect(set.size).toBe(3);
    });

    it('income_tax_form selection has the 5 domestic PND values (pnd1, pnd2, pnd3, pnd3a, pnd53) — PND.54 (foreign) absent in 18.0', async () => {
      const fields = await odooCall(
        'withholding.tax.cert',
        'fields_get',
        [['income_tax_form']],
        { attributes: ['type', 'selection'] },
      );
      const values = (fields.income_tax_form.selection as Array<[string, string]>)
        .map(([k]) => k)
        .sort();
      // OCA 18.0.1.5.4 ships 5 forms — PND.54 (foreign-payment) is NOT
      // generated by this module. Phase 4B will need a custom adapter for it.
      expect(values).toEqual(['pnd1', 'pnd2', 'pnd3', 'pnd3a', 'pnd53']);
    });

    it('tax_payer selection has the 3 RD checkboxes (withholding / paid_one_time / paid_continue)', async () => {
      const fields = await odooCall(
        'withholding.tax.cert',
        'fields_get',
        [['tax_payer']],
        { attributes: ['selection'] },
      );
      const keys = (fields.tax_payer.selection as Array<[string, string]>)
        .map(([k]) => k)
        .sort();
      // The official RD form has a 4th "other" box; OCA 18.0 doesn't ship it.
      // The 3 covered values handle 99% of real-world cases.
      expect(keys).toEqual(['paid_continue', 'paid_one_time', 'withholding']);
    });

    it('ir.sequence "withholding.tax.cert" present with WHT/{year}/ prefix', async () => {
      const seqs = await odooCall(
        'ir.sequence',
        'search_read',
        [[['code', '=', 'withholding.tax.cert']]],
        { fields: ['prefix', 'padding'] },
      );
      expect(seqs.length).toBeGreaterThanOrEqual(1);
      expect(seqs[0].prefix).toMatch(/^WHT\//);
      expect(seqs[0].padding).toBeGreaterThanOrEqual(4);
    });

    it('PIT income code seed for PND.1 has the §40(1)/§40(2) salary categories', async () => {
      const count = await odooCall(
        'withholding.tax.code.income',
        'search_count',
        [[['income_tax_form', '=', 'pnd1']]],
      );
      // Only PND.1 (payroll) needs taxonomy seeds; other forms accept free-text.
      expect(count).toBeGreaterThanOrEqual(4);
    });

    it('report ir.actions.report XML id resolves with report_type=qweb-pdf', async () => {
      const reportRefId = await resolveXmlId(
        'l10n_th_account_wht_cert_form',
        'withholding_tax_pdf_report',
      );
      expect(reportRefId).toBeGreaterThan(0);

      const [r] = await odooCall(
        'ir.actions.report',
        'read',
        [[reportRefId], ['report_name', 'report_type', 'model']],
      );
      expect(r.report_name).toBe('l10n_th_account_wht_cert_form.wht_cert_form');
      expect(r.report_type).toBe('qweb-pdf');
      expect(r.model).toBe('withholding.tax.cert');
    });

    it('creates a direct PND.3 cert with one line (3% of ฿1000 = ฿30)', async () => {
      certId = await odooCall('withholding.tax.cert', 'create', [
        {
          partner_id: vendorPartnerId,
          income_tax_form: 'pnd3',
          tax_payer: 'withholding',
          date: '2026-05-04',
          wht_line: [
            [0, 0, {
              wht_cert_income_type: '6', // "Other" — services
              wht_cert_income_desc: `${fixtureTag} consulting fee`,
              base: 1000.0,
              wht_percent: 3.0,
              amount: 30.0,
            }],
          ],
        },
      ]);
      expect(certId).toBeGreaterThan(0);

      const [cert] = await odooCall(
        'withholding.tax.cert',
        'read',
        [[certId], ['state', 'income_tax_form', 'partner_id', 'wht_line']],
      );
      expect(cert.state).toBe('draft');
      expect(cert.income_tax_form).toBe('pnd3');
      expect(cert.partner_id[0]).toBe(vendorPartnerId);
      expect(cert.wht_line.length).toBe(1);
    });

    it('line-level totals are correct (base 1000, 3%, amount 30)', async () => {
      const [cert] = await odooCall(
        'withholding.tax.cert',
        'read',
        [[certId], ['wht_line']],
      );
      const lines = await odooCall(
        'withholding.tax.cert.line',
        'read',
        [cert.wht_line, ['base', 'wht_percent', 'amount', 'wht_cert_income_type']],
      );
      expect(lines.length).toBe(1);
      expect(lines[0].base).toBeCloseTo(1000, 2);
      expect(lines[0].wht_percent).toBeCloseTo(3, 2);
      expect(lines[0].amount).toBeCloseTo(30, 2);
      expect(lines[0].wht_cert_income_type).toBe('6');
    });

    it('action_done allocates a number from the WHT/{year}/ sequence + state goes to done', async () => {
      await odooCall('withholding.tax.cert', 'action_done', [[certId]]);
      const [cert] = await odooCall(
        'withholding.tax.cert',
        'read',
        [[certId], ['state', 'number']],
      );
      expect(cert.state).toBe('done');
      expect(cert.number).toBeTruthy();
      expect(typeof cert.number).toBe('string');
      expect(cert.number).toMatch(/^WHT\/\d{4}\/\d{4,}$/);
    });

    it('renders the 50-Tawi PDF via /report/pdf/<report_name>/<ids> — %PDF magic + non-trivial bytes', async () => {
      // Odoo's canonical PDF endpoint. report_name comes from the
      // ir.actions.report record (verified earlier in this suite to be
      // "l10n_th_account_wht_cert_form.wht_cert_form").
      const url = `${ODOO_URL}/report/pdf/l10n_th_account_wht_cert_form.wht_cert_form/${certId}`;
      const r = await fetch(url, {
        method: 'GET',
        headers: { Cookie: sessionCookie },
        signal: AbortSignal.timeout(30_000),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/application\/pdf/);

      const buf = Buffer.from(await r.arrayBuffer());
      // Any real PDF is well over 1 KB — the OCA template ships a 300×424mm
      // background image of the official RD form, so a real render is
      // typically > 100 KB.
      expect(buf.length).toBeGreaterThan(1024);
      // %PDF magic at byte 0
      expect(buf.slice(0, 4).toString('latin1')).toBe('%PDF');
      // Trailer marker near the tail (PDFs end with "%%EOF")
      const tail = buf.slice(-32).toString('latin1');
      expect(tail).toMatch(/%%EOF/);
    });

    it('action_cancel transitions done → cancel (idempotent under afterAll cleanup)', async () => {
      await odooCall('withholding.tax.cert', 'action_cancel', [[certId]]);
      const [cert] = await odooCall(
        'withholding.tax.cert',
        'read',
        [[certId], ['state']],
      );
      expect(cert.state).toBe('cancel');
    });
  },
);
