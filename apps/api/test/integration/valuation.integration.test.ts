/**
 * Phase 3 Batch 2 valuation tests against the LIVE local Postgres.
 *
 * Verifies:
 *   - receiveStock creates cost layers with correct qty + unit cost
 *   - moving-average cost recompute on receipt
 *   - consumeFEFO drains layers in (expiry NULLS LAST, received_at) order
 *   - per-layer drawdown breakdown stored in stock_moves.layer_consumption
 *   - cost-layer conservation: SUM(qty_received) − SUM(qty_remaining) = SUM(consumption qty)
 *   - cycle-count auto-accept threshold (≤฿100 OR ≤2%)
 *   - cycle-count manager-override path
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { StockService } from '../../src/modules/inventory/application/stock.service';
import { ValuationService } from '../../src/modules/inventory/application/valuation.service';
import { CycleCountService } from '../../src/modules/inventory/application/cycle-count.service';
import {
  InsufficientStockError,
  VarianceRequiresApprovalError,
} from '../../src/modules/inventory/domain/errors';

const CONN =
  process.env.DATABASE_URL || 'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';

let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;
let stock: StockService;
let valuation: ValuationService;
let cycleCount: CycleCountService;

const TEST_PRODUCT_ID = uuidv7();
const TEST_WAREHOUSE_CODE = `V${Date.now() % 1_000_000_000}`;
let TEST_WAREHOUSE_ID = '';

beforeAll(async () => {
  client = postgres(CONN, { max: 30 });
  db = drizzle(client) as unknown as ReturnType<typeof drizzle>;

  const [whRow] = await client`
    INSERT INTO custom.warehouses (code, name)
    VALUES (${TEST_WAREHOUSE_CODE}, 'Valuation Test Warehouse')
    RETURNING id::text
  `;
  TEST_WAREHOUSE_ID = whRow.id;

  await client`
    INSERT INTO custom.products (id, name, price_cents)
    VALUES (${TEST_PRODUCT_ID}, ${'TEST-VALUATION-' + Date.now()}, 100)
  `;

  // Seed an extra MAIN warehouse if not present so resolveMainWarehouse() works.
  await client`
    INSERT INTO custom.warehouses (code, name)
    VALUES ('MAIN', 'Main Warehouse')
    ON CONFLICT (code) DO NOTHING
  `;

  const eventBus = { publish: () => {} } as any;
  stock = new StockService(db, eventBus);
  valuation = new ValuationService(db);
  cycleCount = new CycleCountService(db, stock);
}, 30_000);

afterAll(async () => {
  if (TEST_WAREHOUSE_ID) {
    await client`DELETE FROM custom.cycle_count_lines WHERE product_id = ${TEST_PRODUCT_ID}`;
    await client`DELETE FROM custom.cycle_count_sessions WHERE warehouse_id = ${TEST_WAREHOUSE_ID}`;
    await client`DELETE FROM custom.stock_moves WHERE product_id = ${TEST_PRODUCT_ID}`;
    await client`DELETE FROM custom.cost_layers WHERE product_id = ${TEST_PRODUCT_ID}`;
    await client`DELETE FROM custom.stock_quants WHERE product_id = ${TEST_PRODUCT_ID}`;
    await client`DELETE FROM custom.products WHERE id = ${TEST_PRODUCT_ID}`;
    await client`DELETE FROM custom.warehouses WHERE id = ${TEST_WAREHOUSE_ID}`;
  }
  await client?.end();
}, 15_000);

async function resetState() {
  await client`DELETE FROM custom.stock_moves WHERE product_id = ${TEST_PRODUCT_ID}`;
  await client`DELETE FROM custom.cost_layers WHERE product_id = ${TEST_PRODUCT_ID}`;
  await client`UPDATE custom.stock_quants
                 SET qty_on_hand = 0, avg_cost_cents = NULL
               WHERE product_id = ${TEST_PRODUCT_ID} AND warehouse_id = ${TEST_WAREHOUSE_ID}`;
}

describe('ValuationService + StockService.receiveStock/consumeFEFO', () => {
  it('receiveStock creates a cost layer + recomputes moving avg cost', async () => {
    await resetState();

    const r1 = await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 10,
      unitCostCents: 100,
      sourceModule: 'test',
      sourceId: 'recv-1',
    });
    expect(r1.newQtyOnHand).toBe(10);
    expect(r1.newAvgCostCents).toBe(100);

    // Receive 10 more at higher cost → avg = (10*100 + 10*200)/20 = 150
    const r2 = await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 10,
      unitCostCents: 200,
      sourceModule: 'test',
      sourceId: 'recv-2',
    });
    expect(r2.newQtyOnHand).toBe(20);
    expect(r2.newAvgCostCents).toBe(150);

    // Cost layers exist
    const layers = await valuation.getCostLayers(TEST_PRODUCT_ID, TEST_WAREHOUSE_ID);
    expect(layers).toHaveLength(2);
    expect(layers.every((l) => l.qtyRemaining === 10)).toBe(true);
  });

  it('consumeFEFO drains layers in oldest-first order when no expiry set', async () => {
    await resetState();

    const r1 = await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 5,
      unitCostCents: 100,
      sourceModule: 'test',
      sourceId: 'fifo-recv-1',
    });
    // Sleep 5ms to ensure distinct received_at
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 5,
      unitCostCents: 200,
      sourceModule: 'test',
      sourceId: 'fifo-recv-2',
    });

    const consumed = await stock.consumeFEFO({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 7,
      sourceModule: 'test',
      sourceId: 'fifo-consume-1',
    });

    // Should drain 5 from r1.layer (cost 100) + 2 from r2.layer (cost 200)
    expect(consumed.layerConsumption).toHaveLength(2);
    expect(consumed.layerConsumption[0].layerId).toBe(r1.layerId);
    expect(consumed.layerConsumption[0].qty).toBe(5);
    expect(consumed.layerConsumption[0].unitCostCents).toBe(100);
    expect(consumed.layerConsumption[1].layerId).toBe(r2.layerId);
    expect(consumed.layerConsumption[1].qty).toBe(2);
    expect(consumed.layerConsumption[1].unitCostCents).toBe(200);
    expect(consumed.totalCostCents).toBe(5 * 100 + 2 * 200);
    expect(consumed.newQtyOnHand).toBe(3);
  });

  it('consumeFEFO drains by expiry first (FEFO not FIFO) when expiry_date is set', async () => {
    await resetState();

    // Layer 1: received first but expires LATER
    const oldButLater = await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 5,
      unitCostCents: 100,
      expiryDate: '2027-01-01',
      sourceModule: 'test',
      sourceId: 'fefo-recv-1',
    });
    await new Promise((r) => setTimeout(r, 5));
    // Layer 2: received second but expires SOONER
    const newButSooner = await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 5,
      unitCostCents: 200,
      expiryDate: '2026-06-01',
      sourceModule: 'test',
      sourceId: 'fefo-recv-2',
    });

    const consumed = await stock.consumeFEFO({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 3,
      sourceModule: 'test',
      sourceId: 'fefo-consume-1',
    });

    // Newer-but-sooner-expiry should drain first
    expect(consumed.layerConsumption).toHaveLength(1);
    expect(consumed.layerConsumption[0].layerId).toBe(newButSooner.layerId);
    expect(consumed.layerConsumption[0].qty).toBe(3);
    expect(consumed.totalCostCents).toBe(3 * 200);

    const layers = await valuation.getCostLayers(TEST_PRODUCT_ID, TEST_WAREHOUSE_ID);
    const oldLayer = layers.find((l) => l.id === oldButLater.layerId)!;
    const newLayer = layers.find((l) => l.id === newButSooner.layerId)!;
    expect(oldLayer.qtyRemaining).toBe(5);
    expect(newLayer.qtyRemaining).toBe(2);
  });

  it('cost-layer conservation: SUM(received) − SUM(remaining) = SUM(consumption qty)', async () => {
    await resetState();

    await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 100,
      unitCostCents: 50,
      sourceModule: 'test',
      sourceId: 'cons-recv-1',
    });
    await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 50,
      unitCostCents: 75,
      sourceModule: 'test',
      sourceId: 'cons-recv-2',
    });

    // Multiple consumptions — different qty sizes
    for (let i = 0; i < 5; i++) {
      await stock.consumeFEFO({
        productId: TEST_PRODUCT_ID,
        warehouseId: TEST_WAREHOUSE_ID,
        qty: 10 + i,
        sourceModule: 'test',
        sourceId: `cons-${i}`,
      });
    }

    const totalsRow = await client`
      SELECT
        (SELECT COALESCE(SUM(qty_received::numeric), 0) FROM custom.cost_layers WHERE product_id = ${TEST_PRODUCT_ID}) AS received,
        (SELECT COALESCE(SUM(qty_remaining::numeric), 0) FROM custom.cost_layers WHERE product_id = ${TEST_PRODUCT_ID}) AS remaining,
        (SELECT COALESCE(-SUM(qty::numeric), 0) FROM custom.stock_moves WHERE product_id = ${TEST_PRODUCT_ID} AND move_type IN ('sale','damage','expire','transfer_out')) AS consumed
    `;
    const received = Number(totalsRow[0].received);
    const remaining = Number(totalsRow[0].remaining);
    const consumed = Number(totalsRow[0].consumed);

    expect(received - remaining).toBe(consumed);
    expect(consumed).toBe(10 + 11 + 12 + 13 + 14); // 60
  });

  it('consumeFEFO throws InsufficientStockError when nothing available and no override', async () => {
    await resetState();
    await expect(
      stock.consumeFEFO({
        productId: TEST_PRODUCT_ID,
        warehouseId: TEST_WAREHOUSE_ID,
        qty: 1,
        sourceModule: 'test',
        sourceId: 'fail-1',
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('consumeFEFO with approvedBy creates a layerless shortfall slice', async () => {
    await resetState();
    await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 2,
      unitCostCents: 100,
      sourceModule: 'test',
      sourceId: 'shortfall-recv',
    });
    const consumed = await stock.consumeFEFO({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 5,
      approvedBy: 'manager-1',
      reason: 'damaged inventory write-off',
      sourceModule: 'test',
      sourceId: 'shortfall-consume',
    });
    // 2 from layer + 3 layerless
    expect(consumed.layerConsumption).toHaveLength(2);
    expect(consumed.layerConsumption[0].qty).toBe(2);
    expect(consumed.layerConsumption[1].layerId).toBe('');
    expect(consumed.layerConsumption[1].qty).toBe(3);
    expect(consumed.newQtyOnHand).toBe(-3);
  });

  it('CONCURRENT FEFO: 5 parallel sales of 4 units against 4 layers of 5 units each — total consumption matches and conservation holds', async () => {
    await resetState();
    // Seed 4 layers of 5 units, increasing cost. 20 total units; 5 parallel
    // consumers each take 4 → 20 consumed exactly (no leftover, no shortfall).
    for (let i = 0; i < 4; i++) {
      await stock.receiveStock({
        productId: TEST_PRODUCT_ID,
        warehouseId: TEST_WAREHOUSE_ID,
        qty: 5,
        unitCostCents: 100 + i * 100,
        sourceModule: 'test',
        sourceId: `concurrent-fefo-recv-${i}`,
      });
      await new Promise((r) => setTimeout(r, 5)); // distinct received_at
    }

    const consumes = Array.from({ length: 5 }, (_, i) =>
      stock.consumeFEFO({
        productId: TEST_PRODUCT_ID,
        warehouseId: TEST_WAREHOUSE_ID,
        qty: 4,
        sourceModule: 'test',
        sourceId: `concurrent-fefo-consume-${i}-${Date.now()}`,
      }),
    );
    const results = await Promise.all(consumes);

    // All 5 succeeded.
    expect(results).toHaveLength(5);
    const totalConsumed = results.reduce(
      (sum, r) => sum + r.layerConsumption.reduce((s, c) => s + c.qty, 0),
      0,
    );
    expect(totalConsumed).toBe(20);

    // Conservation: no layer over-drained, no negative remaining.
    const layers = await valuation.getCostLayers(TEST_PRODUCT_ID, TEST_WAREHOUSE_ID);
    for (const l of layers) {
      expect(l.qtyRemaining).toBeGreaterThanOrEqual(0);
      expect(l.qtyRemaining).toBeLessThanOrEqual(l.qtyReceived);
    }
    const totalRemaining = layers.reduce((s, l) => s + l.qtyRemaining, 0);
    expect(totalRemaining).toBe(0);

    // Final quant.
    const onHand = await stock.getQuantOnHand(TEST_PRODUCT_ID, TEST_WAREHOUSE_ID);
    expect(onHand).toBe(0);
  });

  it('valuation.getValuation matches sum(qty_remaining * unit_cost) per warehouse', async () => {
    await resetState();
    await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 10,
      unitCostCents: 1000,
      sourceModule: 'test',
      sourceId: 'val-1',
    });
    await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 5,
      unitCostCents: 1500,
      sourceModule: 'test',
      sourceId: 'val-2',
    });
    await stock.consumeFEFO({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 3,
      sourceModule: 'test',
      sourceId: 'val-consume',
    });
    // Remaining: 7 @ 1000 + 5 @ 1500 = 7000 + 7500 = 14500
    const lines = await valuation.getValuation({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].qtyOnHand).toBe(12);
    expect(lines[0].layerValueCents).toBe(14500);
  });
});

describe('CycleCountService', () => {
  it('auto-accepts variance ≤ ฿100 (10000 satang)', async () => {
    await resetState();
    await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 100,
      unitCostCents: 50, // 100 units × 50 satang = ฿50 of inventory
      sourceModule: 'test',
      sourceId: 'cc-recv-auto',
    });

    const opened = await cycleCount.open({
      warehouseId: TEST_WAREHOUSE_ID,
      counterUserId: '019dd000-0000-0000-0000-000000000000',
    });
    expect(opened.lineCount).toBeGreaterThan(0);

    // Counted 99 instead of 100 → variance −1 unit × 50 satang = −฿0.50 (well under threshold)
    const submitted = await cycleCount.submitCount({
      sessionId: opened.sessionId,
      lines: [{ productId: TEST_PRODUCT_ID, countedQty: 99 }],
    });
    expect(submitted.autoAcceptable).toBe(1);
    expect(submitted.breaches).toBe(0);

    const posted = await cycleCount.post({ sessionId: opened.sessionId });
    expect(posted.movesCreated).toBe(1);
    expect(posted.requiresApproval).toBe(false);

    // Quant should now be 99
    const onHand = await stock.getQuantOnHand(TEST_PRODUCT_ID, TEST_WAREHOUSE_ID);
    expect(onHand).toBe(99);
  });

  it('requires approvedBy when variance breaches both ฿100 AND 2%', async () => {
    await resetState();
    // 100 units @ 1000 satang = ฿1000. A 5-unit miss = ฿50 cash (under 10000)
    // BUT 5/100 = 5% (over 2%) → still breaches the % gate
    await stock.receiveStock({
      productId: TEST_PRODUCT_ID,
      warehouseId: TEST_WAREHOUSE_ID,
      qty: 100,
      unitCostCents: 1000,
      sourceModule: 'test',
      sourceId: 'cc-recv-breach',
    });

    const opened = await cycleCount.open({
      warehouseId: TEST_WAREHOUSE_ID,
      counterUserId: '019dd000-0000-0000-0000-000000000001',
    });
    const submitted = await cycleCount.submitCount({
      sessionId: opened.sessionId,
      lines: [{ productId: TEST_PRODUCT_ID, countedQty: 95 }], // 5% variance
    });
    expect(submitted.breaches).toBe(1);
    expect(submitted.autoAcceptable).toBe(0);

    // Posting without approvedBy should throw
    await expect(cycleCount.post({ sessionId: opened.sessionId })).rejects.toBeInstanceOf(
      VarianceRequiresApprovalError,
    );

    // With approvedBy → succeeds
    const posted = await cycleCount.post({
      sessionId: opened.sessionId,
      approvedBy: '019dd000-0000-0000-0000-000000000099',
    });
    expect(posted.movesCreated).toBe(1);

    const onHand = await stock.getQuantOnHand(TEST_PRODUCT_ID, TEST_WAREHOUSE_ID);
    expect(onHand).toBe(95);
  });
});
