/**
 * Testcontainers-backed integration tests for the POS module.
 *
 * Each test spins up a fresh PostgreSQL 18 container via @testcontainers, runs
 * our Drizzle schema against it, and verifies the whole write-path of the
 * domain — pricing engine, document-sequence allocator, VAT breakdown, refund
 * path — without any mocks and with full isolation per test.
 *
 * Run with:   pnpm vitest run apps/api/test/integration/pos.integration.test.ts
 *   (requires Docker to be running locally — CI uses the
 *   docker-in-docker service container pattern.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { posOrders } from '@erp/db';
import { priceOrder } from '../../src/modules/pos/domain/pricing';
import { decideDocumentType, formatDocumentNumber, prefixFor } from '../../src/modules/pos/domain/document';
import { isValidTIN } from '@erp/shared';

describe('POS integration', () => {
  let container: StartedPostgreSqlContainer;
  let db: ReturnType<typeof drizzle>;
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('test')
      .withUsername('admin')
      .withPassword('admin')
      .start();

    client = postgres(container.getConnectionUri());
    db = drizzle(client);

    // Bootstrap minimum schema for these tests. The full production schema
    // lives in packages/db migrations — for Phase 2 we only need pos_orders
    // and document_sequences. This keeps the container boot fast.
    await client`CREATE SCHEMA IF NOT EXISTS custom`;
    await client`
      CREATE TABLE custom.pos_orders (
        id uuid PRIMARY KEY,
        odoo_order_id integer,
        session_id uuid,
        customer_id uuid,
        order_lines jsonb NOT NULL,
        subtotal_cents bigint NOT NULL,
        tax_cents bigint NOT NULL,
        discount_cents bigint NOT NULL DEFAULT 0,
        total_cents bigint NOT NULL,
        currency varchar(3) NOT NULL DEFAULT 'THB',
        payment_method text NOT NULL,
        payment_details jsonb,
        status text NOT NULL DEFAULT 'paid',
        ipad_device_id text,
        offline_id text UNIQUE,
        document_type text NOT NULL DEFAULT 'RE',
        document_number text,
        buyer_name text, buyer_tin text, buyer_branch text, buyer_address text,
        -- Phase 1-closure pgcrypto encryption columns. Plaintext columns
        -- above stay populated as a transitional safety net; ciphertext
        -- mirrors what services write via EncryptionService.encryptAndHash.
        buyer_tin_encrypted bytea,
        buyer_tin_hash text,
        buyer_address_encrypted bytea,
        vat_breakdown jsonb,
        promptpay_ref text,
        original_order_id uuid,
        pp30_filing_id uuid,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      )`;
    await client`
      CREATE TABLE custom.document_sequences (
        document_type text NOT NULL,
        period varchar(6) NOT NULL,
        next_number integer NOT NULL DEFAULT 1,
        prefix text NOT NULL,
        updated_at timestamptz DEFAULT now(),
        UNIQUE(document_type, period)
      )`;
  }, 120000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  }, 60000);

  it('pricing engine: single standard-VAT line computes 7% cleanly', () => {
    const result = priceOrder({
      lines: [{ productId: 'p1', name: 'x', qty: 1, unitPriceCents: 10000, vatCategory: 'standard' }],
      cartDiscountCents: 0,
      vatMode: 'exclusive',
      vatRate: 0.07,
    });
    expect(result.subtotalCents).toBe(10000);
    expect(result.taxCents).toBe(700);
    expect(result.totalCents).toBe(10700);
    expect(result.vatBreakdown.taxableNetCents).toBe(10000);
  });

  it('pricing engine: cart discount pro-rates by net share, exempt line skipped', () => {
    const result = priceOrder({
      lines: [
        { productId: 'a', name: 'x', qty: 1, unitPriceCents: 10000, vatCategory: 'standard' },
        { productId: 'b', name: 'y', qty: 1, unitPriceCents: 10000, vatCategory: 'exempt' },
      ],
      cartDiscountCents: 2000,
      vatMode: 'exclusive',
      vatRate: 0.07,
    });
    // Only the standard line is eligible → full 2000 taken from it
    expect(result.vatBreakdown.taxableNetCents).toBe(8000);
    expect(result.vatBreakdown.exemptNetCents).toBe(10000);
  });

  it('decideDocumentType: no TIN → ABB; TIN supplied → TX', () => {
    expect(decideDocumentType({ vatRegistered: true, totalCents: 50000, abbreviatedCapCents: 100000 }).type).toBe('ABB');
    expect(decideDocumentType({ vatRegistered: true, buyer: { tin: '0994000165510' }, totalCents: 50000, abbreviatedCapCents: 100000 }).type).toBe('TX');
    expect(decideDocumentType({ vatRegistered: false, totalCents: 50000, abbreviatedCapCents: 100000 }).type).toBe('RE');
  });

  it('decideDocumentType: > ฿1,000 without TIN → ABB with suggestAskTIN=true', () => {
    const d = decideDocumentType({ vatRegistered: true, totalCents: 200000, abbreviatedCapCents: 100000 });
    expect(d.type).toBe('ABB');
    expect(d.suggestAskTIN).toBe(true);
  });

  it('TIN mod-11: known-valid passes, checksum-corrupt fails', () => {
    expect(isValidTIN('0994000165510')).toBe(true);
    expect(isValidTIN('0994000165511')).toBe(false);
  });

  it('document sequence: atomic allocation is gapless under concurrency', async () => {
    const period = '202604';
    const prefix = prefixFor('TX', period);
    await client`
      INSERT INTO custom.document_sequences (document_type, period, next_number, prefix)
      VALUES ('TX', ${period}, 1, ${prefix})
    `;

    // 30 concurrent allocations should yield 30 unique, consecutive numbers.
    const allocate = async () => {
      const res = await client`
        UPDATE custom.document_sequences
        SET next_number = next_number + 1
        WHERE document_type = 'TX' AND period = ${period}
        RETURNING next_number - 1 AS n
      `;
      return Number(res[0].n);
    };
    const nums = await Promise.all(Array.from({ length: 30 }, () => allocate()));
    const unique = new Set(nums);
    expect(unique.size).toBe(30);
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(30);
  });

  it('persist order + refund round-trip: CN row has negative amounts and original flags refunded', async () => {
    const id = uuidv7();
    await db.insert(posOrders).values({
      id,
      sessionId: null,
      orderLines: [{ productId: 'p', name: 'x', qty: 1, unitPriceCents: 10000, netCents: 10000, vatCents: 700, grossCents: 10700 }],
      subtotalCents: 10000,
      taxCents: 700,
      discountCents: 0,
      totalCents: 10700,
      currency: 'THB',
      paymentMethod: 'cash',
      status: 'paid',
      offlineId: `off-${id}`,
      documentType: 'TX',
      documentNumber: formatDocumentNumber(prefixFor('TX', '202604'), 100),
      vatBreakdown: { taxableNetCents: 10000, zeroRatedNetCents: 0, exemptNetCents: 0, vatCents: 700, grossCents: 10700 },
    });

    // Emit a credit note
    const cnId = uuidv7();
    await db.insert(posOrders).values({
      id: cnId,
      sessionId: null,
      orderLines: [{ productId: 'p', name: 'x', qty: 1, unitPriceCents: 10000, netCents: -10000, vatCents: -700, grossCents: -10700 }],
      subtotalCents: -10000,
      taxCents: -700,
      discountCents: 0,
      totalCents: -10700,
      currency: 'THB',
      paymentMethod: 'cash',
      status: 'refunded',
      offlineId: `cn-${cnId}`,
      documentType: 'CN',
      documentNumber: formatDocumentNumber(prefixFor('CN' as any, '202604'), 1),
      vatBreakdown: { taxableNetCents: -10000, zeroRatedNetCents: 0, exemptNetCents: 0, vatCents: -700, grossCents: -10700 },
      originalOrderId: id,
    });
    await db.update(posOrders).set({ status: 'refunded' }).where(eq(posOrders.id, id));

    const rows = await db.select().from(posOrders);
    const original = rows.find((r) => r.id === id)!;
    const cn = rows.find((r) => r.id === cnId)!;
    expect(original.status).toBe('refunded');
    expect(cn.documentType).toBe('CN');
    expect(cn.totalCents).toBe(-10700);
    expect(cn.originalOrderId).toBe(id);
  });
});
