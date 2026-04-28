/**
 * Phase 3 inventory integration tests.
 *
 * Runs against the LIVE local Postgres (custom schema), not testcontainers,
 * because Docker isn't always available during dev. Uses a unique test product
 * + warehouse so the concurrent-decrement gate test doesn't pollute real data.
 *
 * Phase 3 → Phase 4 gate item:
 *   "10 parallel POS sales of last unit → exactly 9 InsufficientStockError + 1 success"
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { StockService } from '../../src/modules/inventory/application/stock.service';
import { InsufficientStockError } from '../../src/modules/inventory/domain/errors';

const CONN =
  process.env.DATABASE_URL || 'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';

let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;
let service: StockService;

const TEST_PRODUCT_ID = uuidv7();
// warehouses.code is varchar(16); keep it short enough to fit.
const TEST_WAREHOUSE_CODE = `T${Date.now() % 1_000_000_000}`;
let TEST_WAREHOUSE_ID = '';

beforeAll(async () => {
  client = postgres(CONN, { max: 30 });
  db = drizzle(client) as unknown as ReturnType<typeof drizzle>;

  // Create an isolated test warehouse + product (clean up in afterAll).
  const [whRow] = await client`
    INSERT INTO custom.warehouses (code, name)
    VALUES (${TEST_WAREHOUSE_CODE}, 'Concurrent Test Warehouse')
    RETURNING id::text
  `;
  TEST_WAREHOUSE_ID = whRow.id;

  await client`
    INSERT INTO custom.products (id, name, price_cents)
    VALUES (${TEST_PRODUCT_ID}, ${'TEST-WIDGET-' + Date.now()}, 100)
  `;

  await client`
    INSERT INTO custom.stock_quants (product_id, warehouse_id, qty_on_hand)
    VALUES (${TEST_PRODUCT_ID}, ${TEST_WAREHOUSE_ID}, 1)
  `;

  const eventBus = { publish: () => {} } as any;
  service = new StockService(db, eventBus);
}, 30_000);

afterAll(async () => {
  if (TEST_WAREHOUSE_ID) {
    await client`DELETE FROM custom.stock_moves WHERE product_id = ${TEST_PRODUCT_ID}`;
    await client`DELETE FROM custom.stock_quants WHERE product_id = ${TEST_PRODUCT_ID}`;
    await client`DELETE FROM custom.products WHERE id = ${TEST_PRODUCT_ID}`;
    await client`DELETE FROM custom.warehouses WHERE id = ${TEST_WAREHOUSE_ID}`;
  }
  await client?.end();
}, 15_000);

describe('StockService (Phase 3 gate)', () => {
  it('decrements quant by qty (single-threaded sanity)', async () => {
    await client`UPDATE custom.stock_quants SET qty_on_hand = 5
                  WHERE product_id = ${TEST_PRODUCT_ID} AND warehouse_id = ${TEST_WAREHOUSE_ID}`;
    const r = await service.applyMove({
      productId: TEST_PRODUCT_ID,
      qty: -2,
      moveType: 'sale',
      fromWarehouseId: TEST_WAREHOUSE_ID,
    });
    expect(r.newQtyOnHand).toBe(3);
  });

  it('throws InsufficientStockError when qty would go negative without approvedBy', async () => {
    await client`UPDATE custom.stock_quants SET qty_on_hand = 0
                  WHERE product_id = ${TEST_PRODUCT_ID} AND warehouse_id = ${TEST_WAREHOUSE_ID}`;
    await expect(
      service.applyMove({
        productId: TEST_PRODUCT_ID,
        qty: -1,
        moveType: 'sale',
        fromWarehouseId: TEST_WAREHOUSE_ID,
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('approvedBy override allows negative stock (cycle-count adjustment use case)', async () => {
    await client`UPDATE custom.stock_quants SET qty_on_hand = 0
                  WHERE product_id = ${TEST_PRODUCT_ID} AND warehouse_id = ${TEST_WAREHOUSE_ID}`;
    const r = await service.applyMove({
      productId: TEST_PRODUCT_ID,
      qty: -1,
      moveType: 'adjust',
      fromWarehouseId: TEST_WAREHOUSE_ID,
      approvedBy: 'manager-uuid',
      reason: 'damaged unit',
    });
    expect(r.newQtyOnHand).toBe(-1);
  });

  it('GATE: 10 parallel decrements of last unit → 1 success, 9 InsufficientStockError', async () => {
    await client`UPDATE custom.stock_quants SET qty_on_hand = 1
                  WHERE product_id = ${TEST_PRODUCT_ID} AND warehouse_id = ${TEST_WAREHOUSE_ID}`;
    // Wipe move history so the idempotency UNIQUE on
    // (source_module, source_id, product_id) doesn't collapse our 10 calls.
    await client`DELETE FROM custom.stock_moves WHERE product_id = ${TEST_PRODUCT_ID}`;

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        service.applyMove({
          productId: TEST_PRODUCT_ID,
          qty: -1,
          moveType: 'sale',
          fromWarehouseId: TEST_WAREHOUSE_ID,
          sourceModule: 'concurrent_test',
          sourceId: `attempt-${i}-${Date.now()}`,
        }),
      ),
    );

    const succeeded = attempts.filter((a) => a.status === 'fulfilled').length;
    const failed = attempts.filter(
      (a) =>
        a.status === 'rejected' &&
        (a as PromiseRejectedResult).reason instanceof InsufficientStockError,
    ).length;

    expect(succeeded).toBe(1);
    expect(failed).toBe(9);

    const final = await client`SELECT qty_on_hand::numeric AS q FROM custom.stock_quants
      WHERE product_id = ${TEST_PRODUCT_ID} AND warehouse_id = ${TEST_WAREHOUSE_ID}`;
    expect(Number(final[0].q)).toBe(0); // exactly zero, never negative
  }, 30_000);

  it('idempotent replay — same (sourceModule, sourceId, productId) → no double decrement', async () => {
    await client`UPDATE custom.stock_quants SET qty_on_hand = 5
                  WHERE product_id = ${TEST_PRODUCT_ID} AND warehouse_id = ${TEST_WAREHOUSE_ID}`;
    await client`DELETE FROM custom.stock_moves WHERE product_id = ${TEST_PRODUCT_ID}`;

    const args = {
      productId: TEST_PRODUCT_ID,
      qty: -2,
      moveType: 'sale' as const,
      fromWarehouseId: TEST_WAREHOUSE_ID,
      sourceModule: 'pos',
      sourceId: `order-XYZ-${Date.now()}:product-A`,
    };
    const r1 = await service.applyMove(args);
    const r2 = await service.applyMove(args);
    expect(r1.moveId).toBe(r2.moveId);

    const final = await client`SELECT qty_on_hand::numeric AS q FROM custom.stock_quants
      WHERE product_id = ${TEST_PRODUCT_ID} AND warehouse_id = ${TEST_WAREHOUSE_ID}`;
    expect(Number(final[0].q)).toBe(3); // -2 once, not -4
  });
});
