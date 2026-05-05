/**
 * 🇹🇭 §86/4 multi-branch sequence allocator — Phase 2/4 gate item.
 *
 * Plan: "Multi-branch sequential numbers independent per branch; total
 * branches tested." Format: `{BR}-TX-YYMM-#####` for non-default branch,
 * legacy `TX-YYMM-#####` for HQ ('00000').
 *
 * Scenarios verified:
 *   1. HQ branch keeps the legacy prefix (backward compatibility)
 *   2. Non-HQ branch gets the {BR}-prefixed format
 *   3. Two branches allocate concurrently in the same period — no collision,
 *      each branch's sequence is gapless.
 *   4. The same (type, period) but different branches → independent counters.
 *   5. Final number is unique across branches (the BR- prefix guarantees it).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { DocumentSequenceService } from '../../src/modules/pos/infrastructure/document-sequence.service';

const CONN =
  process.env.DATABASE_URL || 'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';
let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;
let svc: DocumentSequenceService;

// Use a far-future test period so we don't pollute real periods.
const TEST_NOW = new Date(Date.UTC(2099, 11, 15)); // 2099-12

beforeAll(async () => {
  client = postgres(CONN);
  db = drizzle(client);
  svc = new DocumentSequenceService(db as any);
});

afterAll(async () => {
  // Cleanup the test partitions we created so the table doesn't grow forever.
  await db.execute(
    sql`DELETE FROM custom.document_sequences WHERE period = '209912'`,
  );
  await client.end();
});

describe('per-branch sequence allocator', () => {
  it('HQ (branch 00000) uses legacy prefix TX-YYMM-#####', async () => {
    const a = await svc.allocate('TX', TEST_NOW); // default branch '00000'
    expect(a.branchCode).toBe('00000');
    expect(a.prefix).toBe('TX9912'); // no branch prefix for HQ
    expect(a.number).toMatch(/^TX9912-\d{6}$/);
    expect(a.sequence).toBe(1);
  });

  it('non-HQ branch gets {BR}-TX-YYMM-##### format', async () => {
    const a = await svc.allocate('TX', TEST_NOW, '00099');
    expect(a.branchCode).toBe('00099');
    expect(a.prefix).toBe('00099-TX9912');
    expect(a.number).toMatch(/^00099-TX9912-\d{6}$/);
    expect(a.sequence).toBe(1);
  });

  it('different branches keep independent counters in same (type, period)', async () => {
    // HQ already at sequence=1 from the first test. Allocate again on HQ
    // and on a third branch; each should advance its own counter.
    const hq = await svc.allocate('TX', TEST_NOW); // HQ second
    const br = await svc.allocate('TX', TEST_NOW, '00200'); // brand-new branch

    expect(hq.branchCode).toBe('00000');
    expect(hq.sequence).toBe(2);
    expect(hq.number).toBe('TX9912-000002');

    expect(br.branchCode).toBe('00200');
    expect(br.sequence).toBe(1);
    expect(br.number).toBe('00200-TX9912-000001');
  });

  it('CONCURRENT: 10 parallel allocations on 2 branches → 0 collisions, gapless per branch', async () => {
    // Two brand-new branches so we start from a known state.
    const branchA = '00301';
    const branchB = '00302';

    // 10 alloc calls per branch, fired in parallel.
    const promises: Promise<{ number: string; branchCode: string; sequence: number }>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(svc.allocate('TX', TEST_NOW, branchA));
      promises.push(svc.allocate('TX', TEST_NOW, branchB));
    }
    const results = await Promise.all(promises);

    const aResults = results.filter((r) => r.branchCode === branchA);
    const bResults = results.filter((r) => r.branchCode === branchB);
    expect(aResults).toHaveLength(10);
    expect(bResults).toHaveLength(10);

    // Within each branch, sequences must be 1..10 with no gaps and no dups.
    const aSeqs = aResults.map((r) => r.sequence).sort((x, y) => x - y);
    const bSeqs = bResults.map((r) => r.sequence).sort((x, y) => x - y);
    expect(aSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // The full doc numbers must be globally unique (BR- prefix guarantees it).
    const allNumbers = results.map((r) => r.number);
    const uniqueNumbers = new Set(allNumbers);
    expect(uniqueNumbers.size).toBe(allNumbers.length);

    // Spot-check format: branchA's first row.
    expect(aResults.find((r) => r.sequence === 1)?.number).toBe('00301-TX9912-000001');
    expect(bResults.find((r) => r.sequence === 1)?.number).toBe('00302-TX9912-000001');
  });

  it('peek() returns next number per branch without advancing', async () => {
    const branch = '00500';
    expect(await svc.peek('TX', TEST_NOW, branch)).toBe(1); // not yet allocated
    await svc.allocate('TX', TEST_NOW, branch);
    expect(await svc.peek('TX', TEST_NOW, branch)).toBe(2);
    // Other branches are unaffected.
    expect(await svc.peek('TX', TEST_NOW, '00501')).toBe(1);
  });

  it('CN (credit note) and DN (debit note) also branch-scope correctly', async () => {
    const cn = await svc.allocate('CN', TEST_NOW, '00099');
    expect(cn.prefix).toBe('00099-CN9912');
    expect(cn.number).toBe('00099-CN9912-000001');

    const dn = await svc.allocate('DN', TEST_NOW, '00099');
    expect(dn.prefix).toBe('00099-DN9912');
    expect(dn.number).toBe('00099-DN9912-000001');
  });
});
