/**
 * REAL execution test for gap #8 — queue_job actually runs an async method.
 *
 * The earlier #8 test was schema-only because the JobRunner thread wasn't
 * started in dev compose. This test runs against an Odoo container booted
 * with `--load=web,queue_job --workers=2` so the JobRunner is alive and
 * picks up pending queue.job rows.
 *
 * Scenario:
 *   1. Create a tier.test.record with amount=0
 *   2. Call enqueue_amount_update(target_amount=42) via RPC — this returns
 *      immediately, after enqueueing a queue.job (no work done in the
 *      request thread).
 *   3. Within ~1 s, a queue.job row exists in 'pending' state.
 *   4. Within ~30 s, the JobRunner picks it up: state goes
 *      pending → enqueued → started → done.
 *   5. The side effect lands: tier.test.record.amount = 42.
 *
 * If the JobRunner weren't alive, the queue.job would stay 'pending'
 * forever and the test would time out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ODOO_URL = process.env.ODOO_URL ?? 'http://localhost:8069';
const ODOO_DB = process.env.ODOO_DB ?? 'odoo';
const ODOO_USER = process.env.ODOO_ADMIN_USER ?? 'admin';
const ODOO_PASS = process.env.ODOO_ADMIN_PASSWORD ?? 'admin';

const fixtureTag = `qj-real-${Date.now()}`;
const TARGET_AMOUNT = 42.0;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(await odooReachable())(
  'OCA queue_job REAL execution (gap-fill #8)',
  () => {
    let recordId = 0;
    let jobId = 0;

    beforeAll(async () => {
      const auth = await rpc('/web/session/authenticate', {
        db: ODOO_DB,
        login: ODOO_USER,
        password: ODOO_PASS,
      });
      expect(auth?.uid).toBeGreaterThan(0);

      // Create a tier.test.record with amount=0; the job will set it to 42.
      recordId = await odooCall('tier.test.record', 'create', [
        { name: `${fixtureTag}-record`, amount: 0.0 },
      ]);
      expect(recordId).toBeGreaterThan(0);
    });

    afterAll(async () => {
      // queue.job is intentionally NOT deletable (audit trail). Cleanup
      // is the autovacuum cron's job (default 30-day retention per
      // channel.removal_interval). We don't fight that — leftover test
      // queue.job rows are harmless because each test run uses a unique
      // fixtureTag in the description.
      if (recordId) {
        try { await odooCall('tier.test.record', 'unlink', [[recordId]]); } catch {}
      }
    });

    it('REAL: enqueue_amount_update returns immediately + creates a queue.job row', async () => {
      // Snapshot the pre-enqueue queue.job count
      const before = await odooCall('queue.job', 'search_count', [[]]);

      await odooCall(
        'tier.test.record',
        'enqueue_amount_update',
        [[recordId]],
        { target_amount: TARGET_AMOUNT },
      );

      const after = await odooCall('queue.job', 'search_count', [[]]);
      expect(after).toBe(before + 1);

      // Find OUR job (description was set in the model method).
      const jobs = await odooCall('queue.job', 'search_read',
        [[['name', 'ilike', `${fixtureTag}`]]],
        { fields: ['id', 'state', 'method_name', 'model_name', 'channel'], limit: 1, order: 'id desc' });
      expect(jobs.length).toBe(1);
      jobId = jobs[0].id;
      expect(jobs[0].method_name).toBe('_async_set_amount');
      expect(jobs[0].model_name).toBe('tier.test.record');
      expect(jobs[0].channel).toBe('root');
      expect(['pending', 'enqueued', 'started', 'done']).toContain(jobs[0].state);
    });

    it('REAL: JobRunner picks the job up and runs it within 30 s — state goes to done', async () => {
      // Poll up to 30s in 500ms increments
      const deadline = Date.now() + 30_000;
      let lastState = 'unknown';
      while (Date.now() < deadline) {
        const [job] = await odooCall(
          'queue.job',
          'read',
          [[jobId], ['state', 'exc_info']],
        );
        lastState = job.state;
        if (lastState === 'done') break;
        if (lastState === 'failed') {
          throw new Error(
            `Job failed before completing: state=${lastState}; exc_info=${(job as any).exc_info ?? ''}`,
          );
        }
        await sleep(500);
      }
      expect(lastState).toBe('done');
    });

    it('REAL: side effect landed — tier.test.record.amount is now 42', async () => {
      const [rec] = await odooCall(
        'tier.test.record',
        'read',
        [[recordId], ['amount']],
      );
      expect(rec.amount).toBeCloseTo(TARGET_AMOUNT, 2);
    });

    it('REAL: queue.job has timestamps (date_started + date_done) populated by the runner', async () => {
      const [job] = await odooCall(
        'queue.job',
        'read',
        [[jobId], ['date_created', 'date_started', 'date_done', 'exec_time', 'result']],
      );
      expect(job.date_created).toBeTruthy();
      expect(job.date_started).toBeTruthy();
      expect(job.date_done).toBeTruthy();
      expect(typeof job.exec_time).toBe('number');
      // Our worker returned a string; queue_job stores it as repr in `result`.
      expect(String(job.result)).toContain('set amount to 42');
    });
  },
);
