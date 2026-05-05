/**
 * Live-Odoo integration test for OCA auditlog (server-tools 18.0.2.0.9).
 *
 * Why this matters:
 *   Our NestJS layer already audits mutations via AuditInterceptor → the
 *   custom.audit_events table. But anything that hits Odoo directly (a user
 *   on the Odoo backend UI, an OCA cron, Tier validation actions, etc.)
 *   bypasses our interceptor. auditlog gives us the mirror: per-model rules,
 *   per-CRUD toggles, before/after value capture. Together NestJS audit +
 *   Odoo audit = both runtimes covered, no blind spots.
 *
 * The test:
 *   1. Module + 7 models registered.
 *   2. autovacuum cron exists (default OFF; Phase 4 must enable it for
 *      the 180-day retention story).
 *   3. auditlog.rule field surface: state ∈ {draft, subscribed}, plus
 *      per-CRUD log_* booleans, capture_record, users_to_exclude_ids.
 *   4. End-to-end on res.partner:
 *        - create a draft rule that logs CREATE/WRITE/UNLINK on res.partner
 *        - subscribe() → state=subscribed
 *        - create a test partner → one auditlog.log with method='create'
 *        - write to it (rename) → one log with method='write' + line entries
 *          showing old/new values
 *        - unlink it → one log with method='unlink'
 *        - unsubscribe() → no log fires for a NEW partner created after
 *   5. Cleanup deletes the rule + the test partners + the log rows.
 *
 * NOTE on the noisiest CRUD: log_read=True is *highly* expensive (every
 * access is logged). This test deliberately leaves it off and the
 * inline comments document why for any future Phase 4 wiring.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `audit-test-${Date.now()}`;

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
  'OCA auditlog (live Odoo)',
  () => {
    let partnerModelId = 0;
    let ruleId = 0;
    let testPartnerIds: number[] = [];
    let postUnsubscribePartnerId = 0;
    let logIdsToCleanup: number[] = [];

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      expect(auth?.uid).toBeGreaterThan(0);

      const models = await odooCall(
        'ir.model',
        'search_read',
        [[['model', '=', 'res.partner']]],
        { fields: ['id'], limit: 1 },
      );
      partnerModelId = models[0].id;
    });

    afterAll(async () => {
      // 1. Always unsubscribe so the model patches are removed.
      if (ruleId) {
        try {
          const [r] = await odooCall(
            'auditlog.rule',
            'read',
            [[ruleId], ['state']],
          );
          if (r?.state === 'subscribed') {
            await odooCall('auditlog.rule', 'unsubscribe', [[ruleId]]);
          }
        } catch {
          /* idempotent */
        }
      }

      // 2. Wipe the test partners.
      const allTestPartnerIds = [...testPartnerIds];
      if (postUnsubscribePartnerId) allTestPartnerIds.push(postUnsubscribePartnerId);
      for (const pid of allTestPartnerIds) {
        try {
          await odooCall('res.partner', 'unlink', [[pid]]);
        } catch {
          /* may already be gone */
        }
      }

      // 3. Wipe the audit logs we generated for those partners.
      // After the partner is unlinked the log's res_id is stale but still
      // valid in the auditlog.log table; we delete by name match instead.
      try {
        const logs = await odooCall(
          'auditlog.log',
          'search',
          [
            [
              ['model_model', '=', 'res.partner'],
              '|',
              ['name', 'like', `${fixtureTag}-%`],
              ['name', 'like', `${fixtureTag}_renamed-%`],
            ],
          ],
        );
        if (logs.length) {
          // Cascade unlink will take log.line rows with it.
          await odooCall('auditlog.log', 'unlink', [logs]);
        }
      } catch (e) {
        console.warn(`Could not clean audit logs: ${(e as Error).message}`);
      }

      // 4. Delete the rule itself.
      if (ruleId) {
        try {
          await odooCall('auditlog.rule', 'unlink', [[ruleId]]);
        } catch (e) {
          console.warn(`Could not unlink rule ${ruleId}: ${(e as Error).message}`);
        }
      }
    });

    it('module installed at expected upstream version', async () => {
      const [m] = await odooCall(
        'ir.module.module',
        'search_read',
        [[['name', '=', 'auditlog'], ['state', '=', 'installed']]],
        { fields: ['latest_version'] },
      );
      expect(m.latest_version).toBe('18.0.2.0.9');
    });

    it('all 7 auditlog models registered', async () => {
      const models = await odooCall(
        'ir.model',
        'search_read',
        [[['model', 'like', 'auditlog%']]],
        { fields: ['model'] },
      );
      const set = new Set(models.map((m: any) => m.model));
      expect(set.size).toBe(7);
      for (const m of [
        'auditlog.rule',
        'auditlog.log',
        'auditlog.log.line',
        'auditlog.log.line.view',
        'auditlog.autovacuum',
        'auditlog.http.session',
        'auditlog.http.request',
      ]) {
        expect(set.has(m), `missing model ${m}`).toBe(true);
      }
    });

    it('autovacuum cron is provisioned (default OFF — Phase 4 must enable for retention)', async () => {
      const cronXml = await odooCall(
        'ir.model.data',
        'search_read',
        [[['module', '=', 'auditlog'], ['name', '=', 'ir_cron_auditlog_autovacuum']]],
        { fields: ['res_id'] },
      );
      expect(cronXml).toHaveLength(1);
      const [cron] = await odooCall(
        'ir.cron',
        'read',
        [[cronXml[0].res_id], ['active', 'interval_number', 'interval_type']],
      );
      // Default state is INACTIVE per OCA module — operator must turn it on.
      // We assert the structure rather than the active flag because some
      // sites enable it at install. Both states are valid.
      expect(typeof cron.active).toBe('boolean');
      expect(typeof cron.interval_number).toBe('number');
      expect(typeof cron.interval_type).toBe('string');
    });

    it('auditlog.rule field surface: state ∈ {draft, subscribed}, per-CRUD log_*, capture_record, users_to_exclude_ids', async () => {
      const fields = await odooCall(
        'auditlog.rule',
        'fields_get',
        [
          [
            'state',
            'log_create',
            'log_write',
            'log_unlink',
            'log_read',
            'log_export_data',
            'capture_record',
            'users_to_exclude_ids',
            'fields_to_exclude_ids',
            'model_id',
          ],
        ],
        { attributes: ['type', 'selection', 'relation'] },
      );

      const stateKeys = (fields.state.selection as Array<[string, string]>).map(([k]) => k).sort();
      expect(stateKeys).toEqual(['draft', 'subscribed']);
      expect(fields.log_create.type).toBe('boolean');
      expect(fields.log_write.type).toBe('boolean');
      expect(fields.log_unlink.type).toBe('boolean');
      expect(fields.log_read.type).toBe('boolean');
      expect(fields.log_export_data.type).toBe('boolean');
      expect(fields.capture_record.type).toBe('boolean');
      expect(fields.users_to_exclude_ids.relation).toBe('res.users');
      expect(fields.fields_to_exclude_ids.relation).toBe('ir.model.fields');
      expect(fields.model_id.relation).toBe('ir.model');
    });

    it('creates a draft rule on res.partner: CREATE+WRITE+UNLINK + capture_record (READ off)', async () => {
      ruleId = await odooCall('auditlog.rule', 'create', [
        {
          name: `${fixtureTag}-rule`,
          model_id: partnerModelId,
          log_create: true,
          log_write: true,
          log_unlink: true,
          // log_read deliberately False — see comment on file header
          log_read: false,
          log_export_data: false,
          capture_record: true,
        },
      ]);
      expect(ruleId).toBeGreaterThan(0);

      const [r] = await odooCall(
        'auditlog.rule',
        'read',
        [[ruleId], ['state', 'log_create', 'log_write', 'log_unlink', 'log_read']],
      );
      expect(r.state).toBe('draft');
      expect(r.log_create).toBe(true);
      expect(r.log_write).toBe(true);
      expect(r.log_unlink).toBe(true);
      expect(r.log_read).toBe(false);
    });

    it('subscribe() patches the model and transitions state to subscribed', async () => {
      await odooCall('auditlog.rule', 'subscribe', [[ruleId]]);
      const [r] = await odooCall(
        'auditlog.rule',
        'read',
        [[ruleId], ['state']],
      );
      expect(r.state).toBe('subscribed');
    });

    it('create on res.partner produces a method=create log row', async () => {
      const partnerId = await odooCall('res.partner', 'create', [
        {
          name: `${fixtureTag}-partner-A`,
          email: `${fixtureTag}-A@test.local`,
          is_company: true,
        },
      ]);
      testPartnerIds.push(partnerId);

      // Find the audit log row for THIS partner's create event.
      const logs = await odooCall(
        'auditlog.log',
        'search_read',
        [
          [
            ['model_model', '=', 'res.partner'],
            ['res_id', '=', partnerId],
            ['method', '=', 'create'],
          ],
        ],
        { fields: ['id', 'method', 'name', 'user_id'] },
      );
      expect(logs.length).toBeGreaterThanOrEqual(1);
      logIdsToCleanup.push(...logs.map((l: any) => l.id));

      // 'name' on the log captures the partner's display name (because we
      // turned capture_record on); we only check the prefix because Odoo
      // may augment the name with a tag for company partners.
      const log0 = logs[0];
      expect(log0.method).toBe('create');
      expect(String(log0.name)).toContain(fixtureTag);
    });

    it('write on res.partner produces a method=write log + auditlog.log.line rows with old/new values', async () => {
      const partnerId = testPartnerIds[0];
      const newName = `${fixtureTag}_renamed-partner-A`;

      await odooCall('res.partner', 'write', [[partnerId], { name: newName }]);

      const logs = await odooCall(
        'auditlog.log',
        'search_read',
        [
          [
            ['model_model', '=', 'res.partner'],
            ['res_id', '=', partnerId],
            ['method', '=', 'write'],
          ],
        ],
        { fields: ['id', 'line_ids'], order: 'id desc' },
      );
      expect(logs.length).toBeGreaterThanOrEqual(1);
      logIdsToCleanup.push(...logs.map((l: any) => l.id));

      // The most recent write log should have a line for the 'name' field
      // capturing the old + new value.
      const lineIds = logs[0].line_ids as number[];
      expect(lineIds.length).toBeGreaterThan(0);

      const lines = await odooCall(
        'auditlog.log.line',
        'read',
        [lineIds, ['field_name', 'old_value', 'new_value']],
      );
      const nameLine = lines.find((l: any) => l.field_name === 'name');
      expect(nameLine).toBeTruthy();
      expect(String(nameLine.old_value)).toContain(`${fixtureTag}-partner-A`);
      expect(String(nameLine.new_value)).toContain(newName);
    });

    it('unlink on res.partner produces a method=unlink log', async () => {
      // Create a fresh partner so the unlink doesn't disturb the partner
      // we're using in the write-test (it's already gone in afterAll).
      const partnerId = await odooCall('res.partner', 'create', [
        { name: `${fixtureTag}-partner-B-tobedeleted` },
      ]);
      // NB: not pushing into testPartnerIds since we'll delete it now.

      await odooCall('res.partner', 'unlink', [[partnerId]]);

      const logs = await odooCall(
        'auditlog.log',
        'search_read',
        [
          [
            ['model_model', '=', 'res.partner'],
            ['res_id', '=', partnerId],
            ['method', '=', 'unlink'],
          ],
        ],
        { fields: ['id', 'method'] },
      );
      expect(logs.length).toBeGreaterThanOrEqual(1);
      logIdsToCleanup.push(...logs.map((l: any) => l.id));
      expect(logs[0].method).toBe('unlink');
    });

    it('unsubscribe() removes patches: a partner created AFTER unsubscribe leaves no audit trail', async () => {
      await odooCall('auditlog.rule', 'unsubscribe', [[ruleId]]);
      const [r] = await odooCall(
        'auditlog.rule',
        'read',
        [[ruleId], ['state']],
      );
      expect(r.state).toBe('draft');

      postUnsubscribePartnerId = await odooCall('res.partner', 'create', [
        { name: `${fixtureTag}-partner-C-after-unsub` },
      ]);

      const logs = await odooCall(
        'auditlog.log',
        'search_count',
        [[['res_id', '=', postUnsubscribePartnerId], ['model_model', '=', 'res.partner']]],
      );
      expect(logs).toBe(0);
    });
  },
);
