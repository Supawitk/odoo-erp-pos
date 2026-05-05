/**
 * Phase 3 → Phase 4 outbox resolver — gate item closure.
 *
 * Plan: "Push stock.move via outbox; resolves external_ref → odoo_id from
 * custom.products.odoo_product_id."
 *
 * The resolver lives in OutboxRelayService.resolveExternalRefs() — but it's
 * a private method. To test it without going through Odoo (which the test env
 * doesn't have), we use the public OutboxService.diagnostics() method which
 * runs the same lookup classification: pending rows with a populated
 * odoo_product_id → readyToPush; without → blockedOnMapping.
 *
 * Scenarios:
 *   1. A row referencing a product WITHOUT odoo_product_id → blockedOnMapping
 *   2. A row referencing a product WITH odoo_product_id → readyToPush
 *   3. A row with an unrecognised payload shape → unrecognisedShape
 *   4. Counts are stable across calls (read-only)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { OutboxService } from '../../src/modules/inventory/infrastructure/outbox.service';

const CONN =
  process.env.DATABASE_URL || 'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';
let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;
let svc: OutboxService;

const TEST_PRODUCT_NO_MAPPING = uuidv7();
const TEST_PRODUCT_MAPPED = uuidv7();
const TEST_OUTBOX_IDS: string[] = [];

beforeAll(async () => {
  client = postgres(CONN);
  db = drizzle(client);
  svc = new OutboxService(db as any);

  // Seed two products: one without odoo_product_id, one with.
  await db.execute(sql`
    INSERT INTO custom.products (id, name, price_cents, is_active, odoo_product_id)
    VALUES
      (${TEST_PRODUCT_NO_MAPPING}, 'Outbox Test (no mapping)', 1000, true, NULL),
      (${TEST_PRODUCT_MAPPED},     'Outbox Test (mapped)',    1000, true, 99001)
  `);

  // Seed three pending stock_move outbox rows that reference our test products.
  // Rows must have UNIQUE external_id, so include a random suffix.
  const mkRow = async (productRefOrShape: any, suffix: string) => {
    const id = uuidv7();
    TEST_OUTBOX_IDS.push(id);
    await db.execute(sql`
      INSERT INTO custom.odoo_outbox (id, model, operation, payload, external_id, status)
      VALUES (
        ${id},
        'stock.move',
        'create',
        ${JSON.stringify(productRefOrShape)}::jsonb,
        ${'erp_pos.test_outbox_' + suffix},
        'pending'
      )
    `);
    return id;
  };

  await mkRow(
    { name: 'unmapped sale', product_id: { external_ref: TEST_PRODUCT_NO_MAPPING }, product_uom_qty: 1 },
    'unmapped',
  );
  await mkRow(
    { name: 'mapped sale', product_id: { external_ref: TEST_PRODUCT_MAPPED }, product_uom_qty: 1 },
    'mapped',
  );
  await mkRow(
    { name: 'weird shape', some_other_key: 'no product_id here' },
    'weird',
  );
});

afterAll(async () => {
  if (TEST_OUTBOX_IDS.length > 0) {
    await db.execute(
      sql.raw(
        `DELETE FROM custom.odoo_outbox WHERE id IN (${TEST_OUTBOX_IDS.map((id) => `'${id}'`).join(',')})`,
      ),
    );
  }
  await db.execute(sql`
    DELETE FROM custom.products WHERE id IN (${TEST_PRODUCT_NO_MAPPING}, ${TEST_PRODUCT_MAPPED})
  `);
  await client.end();
});

describe('outbox resolver (via diagnostics)', () => {
  it('classifies pending rows: ready vs blocked vs unrecognised', async () => {
    const diag = await svc.diagnostics();

    // We seeded 3 rows, but the table also holds whatever was pending before.
    // So we can't assert exact totals; we assert OUR rows appear in the right
    // bucket and the totals add up to >= our expected contributions.
    expect(diag.pending).toBeGreaterThanOrEqual(3);
    expect(diag.readyToPush).toBeGreaterThanOrEqual(1);          // mapped
    expect(diag.blockedOnMapping).toBeGreaterThanOrEqual(1);     // unmapped
    expect(diag.unrecognisedShape).toBeGreaterThanOrEqual(1);    // weird

    expect(
      diag.pending,
      'pending should equal sum of all three buckets',
    ).toBe(diag.readyToPush + diag.blockedOnMapping + diag.unrecognisedShape);

    // sampleBlocked is capped at 5 + sorted by created_at — when the backlog
    // is large our test row may not appear. Just verify the shape is sane.
    expect(diag.sampleBlocked.length).toBeLessThanOrEqual(5);
    if (diag.sampleBlocked.length > 0) {
      expect(diag.sampleBlocked[0]).toHaveProperty('id');
      expect(diag.sampleBlocked[0]).toHaveProperty('productId');
    }
  });

  it('is read-only: classifies a second time with same counts', async () => {
    const a = await svc.diagnostics();
    const b = await svc.diagnostics();
    expect(a.pending).toBe(b.pending);
    expect(a.readyToPush).toBe(b.readyToPush);
    expect(a.blockedOnMapping).toBe(b.blockedOnMapping);
  });

  it('promoting a product from unmapped → mapped flips its bucket', async () => {
    const before = await svc.diagnostics();
    // Set odoo_product_id on the previously-unmapped product.
    await db.execute(sql`
      UPDATE custom.products SET odoo_product_id = 99002 WHERE id = ${TEST_PRODUCT_NO_MAPPING}
    `);
    const after = await svc.diagnostics();
    expect(after.readyToPush).toBe(before.readyToPush + 1);
    expect(after.blockedOnMapping).toBe(before.blockedOnMapping - 1);
    // Reset for cleanup hygiene.
    await db.execute(sql`
      UPDATE custom.products SET odoo_product_id = NULL WHERE id = ${TEST_PRODUCT_NO_MAPPING}
    `);
  });

  it('rows the resolver would push: payload survives the JSONB round-trip', async () => {
    // Sanity: the outbox stores payload as JSONB and our test payloads must
    // round-trip — fetch one and verify.
    const r: any = await db.execute(sql`
      SELECT payload FROM custom.odoo_outbox
      WHERE external_id = 'erp_pos.test_outbox_mapped' LIMIT 1
    `);
    const rows: any[] = r.rows ?? r ?? [];
    expect(rows[0]?.payload?.product_id?.external_ref).toBe(TEST_PRODUCT_MAPPED);
    expect(rows[0]?.payload?.product_uom_qty).toBe(1);
  });
});
