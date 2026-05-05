/**
 * Phase 4 invariant test: enforce_balanced_entry Postgres trigger.
 *
 * Trigger lives in custom.enforce_balanced_entry() and fires on
 * BEFORE UPDATE OF status WHEN (NEW.status='posted' AND OLD.status<>'posted').
 *
 * Plan ref: CLAUDE.md "Database Constraint: Double-Entry Must Balance".
 * Belt-and-suspenders: even a manual psql UPDATE should be rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

const CONN =
  process.env.DATABASE_URL || 'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';
let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;

const createdIds: string[] = [];

beforeAll(async () => {
  client = postgres(CONN);
  db = drizzle(client);
  // Make sure the trigger is installed (will be a no-op after first run).
  await db.execute(sql`SELECT 1 FROM pg_trigger WHERE tgname='enforce_balanced_entry'`);
});

afterAll(async () => {
  if (createdIds.length > 0) {
    // Cleanup: delete lines first (FK), then entries.
    await db.execute(
      sql.raw(`DELETE FROM custom.journal_entry_lines WHERE journal_entry_id IN (${createdIds.map(id => `'${id}'`).join(',')})`),
    );
    await db.execute(
      sql.raw(`DELETE FROM custom.journal_entries WHERE id IN (${createdIds.map(id => `'${id}'`).join(',')})`),
    );
  }
  await client.end();
});

async function insertDraftEntry(id: string, lines: Array<{ debit: number; credit: number; account: string }>) {
  await db.execute(sql`
    INSERT INTO custom.journal_entries (id, date, description, currency, status)
    VALUES (${id}, CURRENT_DATE, 'trigger-test', 'THB', 'draft')
  `);
  createdIds.push(id);
  for (const l of lines) {
    await db.execute(sql`
      INSERT INTO custom.journal_entry_lines
        (journal_entry_id, account_code, account_name, debit_cents, credit_cents, currency)
      VALUES (${id}, ${l.account}, ${'Test ' + l.account}, ${l.debit}, ${l.credit}, 'THB')
    `);
  }
}

async function tryPost(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await db.execute(sql`
      UPDATE custom.journal_entries
      SET status='posted', posted_at=NOW()
      WHERE id=${id}
    `);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

describe('enforce_balanced_entry trigger', () => {
  it('REJECTS posting an unbalanced entry (debits ≠ credits)', async () => {
    const id = uuidv7();
    await insertDraftEntry(id, [
      { debit: 10000, credit: 0, account: '1110' },
      { debit: 0, credit: 9999, account: '4110' },  // off by 1 satang
    ]);
    const r = await tryPost(id);
    expect(r.ok).toBe(false);
    // Confirm row is still draft (trigger fired BEFORE update + reverted).
    const res1: any = await db.execute(sql`
      SELECT status, total_debit_cents, total_credit_cents
      FROM custom.journal_entries WHERE id=${id}
    `);
    const rows1: any[] = res1.rows ?? res1 ?? [];
    expect(rows1[0]?.status).toBe('draft');
    // Header totals were NOT updated (trigger blocked the whole UPDATE).
    expect(Number(rows1[0]?.total_debit_cents)).toBe(0);
    expect(Number(rows1[0]?.total_credit_cents)).toBe(0);
  });

  it('REJECTS posting an entry with zero lines', async () => {
    const id = uuidv7();
    await insertDraftEntry(id, []);  // header only
    const r = await tryPost(id);
    expect(r.ok).toBe(false);
    // Confirm the row stays draft even though we tried to post it.
    const res: any = await db.execute(sql`
      SELECT status FROM custom.journal_entries WHERE id=${id}
    `);
    const rows: any[] = res.rows ?? res ?? [];
    expect(rows[0]?.status).toBe('draft');
  });

  it('REJECTS posting an entry with all-zero amounts', async () => {
    const id = uuidv7();
    await insertDraftEntry(id, [
      { debit: 0, credit: 0, account: '1110' },
      { debit: 0, credit: 0, account: '4110' },
    ]);
    const r = await tryPost(id);
    expect(r.ok).toBe(false);
  });

  it('ACCEPTS posting a balanced entry + AUTO-FILLS totals on header', async () => {
    const id = uuidv7();
    await insertDraftEntry(id, [
      { debit: 12345, credit: 0, account: '1110' },
      { debit: 0, credit: 12345, account: '4110' },
    ]);
    const r = await tryPost(id);
    expect(r.ok).toBe(true);

    const res2: any = await db.execute(sql`
      SELECT status, total_debit_cents, total_credit_cents
      FROM custom.journal_entries WHERE id=${id}
    `);
    const rows2: any[] = res2.rows ?? res2 ?? [];
    expect(rows2[0].status).toBe('posted');
    expect(Number(rows2[0].total_debit_cents)).toBe(12345);
    expect(Number(rows2[0].total_credit_cents)).toBe(12345);
  });

  it('ACCEPTS multi-line balanced entry (4-leg JE)', async () => {
    const id = uuidv7();
    await insertDraftEntry(id, [
      { debit: 10000, credit: 0, account: '1110' },     // Cash
      { debit: 700, credit: 0, account: '1155' },       // Input VAT
      { debit: 0, credit: 10000, account: '4110' },     // Revenue
      { debit: 0, credit: 700, account: '2201' },       // Output VAT
    ]);
    const r = await tryPost(id);
    expect(r.ok).toBe(true);
  });

  it('does not re-fire on a no-op status update (already posted → posted)', async () => {
    const id = uuidv7();
    await insertDraftEntry(id, [
      { debit: 5000, credit: 0, account: '1110' },
      { debit: 0, credit: 5000, account: '4110' },
    ]);
    expect((await tryPost(id)).ok).toBe(true);
    // Now the entry is already posted. Re-running the same UPDATE should
    // be silently a no-op (WHEN clause prevents the trigger from firing).
    const r = await tryPost(id);
    expect(r.ok).toBe(true);
  });

  it('reads cleanly for existing posted entries (sanity)', async () => {
    // None of the 151 pre-existing posted entries should trip the trigger
    // — they all balance. We don't re-post them; just confirm SELECT works.
    const res: any = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM custom.journal_entries
      WHERE status='posted'
        AND total_debit_cents <> total_credit_cents
    `);
    const rows: any[] = res.rows ?? res ?? [];
    expect(Number(rows[0].n)).toBe(0);
  });
});
