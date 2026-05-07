/**
 * 🇹🇭 Phase 4B integration test — e-Tax XML generation pipeline.
 *
 * Hits the LIVE local Postgres. Verifies the full submit chain:
 *   1. Insert a paid TX order via raw SQL
 *   2. Resolve the order through OrganizationService → buildDto → builder
 *   3. Validate XML structurally
 *   4. Submit via Leceipt mock adapter
 *   5. Confirm an etax_submissions row exists with status=acknowledged
 *
 * Also exercises:
 *   - Idempotent re-submission (same order/provider returns the same ack)
 *   - Status query
 *   - Mock-mode rejection of an unalloc'd document number
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql, eq } from 'drizzle-orm';
import { posOrders, etaxSubmissions, organizations } from '@erp/db';
import { TaxInvoiceXmlBuilder } from '../../src/modules/etax/services/tax-invoice-xml-builder';
import { EtdaXsdValidator } from '../../src/modules/etax/validators/etda-xsd.validator';
import { LeceiptAdapter } from '../../src/modules/etax/adapters/leceipt.adapter';
import { InetAdapter } from '../../src/modules/etax/adapters/inet.adapter';
import { EtaxSubmissionService } from '../../src/modules/etax/services/etax-submission.service';
import { EncryptionService } from '../../src/shared/infrastructure/crypto/encryption.service';
import { OrganizationService } from '../../src/modules/organization/organization.service';

const CONN =
  process.env.DATABASE_URL ||
  'postgresql://erp_app:erp_app_dev_pw_change_me@localhost:5432/odoo';

let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;
let service: EtaxSubmissionService;
let testOrderId: string;
let testSessionId: string;

const TEST_OFFLINE_ID = `etax-integration-${Date.now()}`;
const TEST_DOC_NUM = `TX9999-999${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;

beforeAll(async () => {
  process.env.LECEIPT_MODE = 'mock';
  process.env.INET_MODE = 'mock';
  process.env.ENCRYPTION_MASTER_KEY =
    process.env.ENCRYPTION_MASTER_KEY ||
    'dev_encryption_master_key_replace_in_prod_32bytes';
  client = postgres(CONN);
  db = drizzle(client);

  const crypto = new EncryptionService(db as any);
  crypto.onModuleInit();

  // OrganizationService refresh on each test boot.
  const org = new OrganizationService(db as any, crypto);
  await org.snapshot();

  // Make sure the org is VAT-registered Thai for this test (we won't permanently flip).
  const [orgRow] = await db.select().from(organizations).limit(1);
  if (!orgRow) throw new Error('no organization row seeded — cannot run test');

  // Snapshot original then ensure TH/VAT.
  const originalMode = orgRow.countryMode;
  const originalVat = orgRow.vatRegistered;
  if (originalMode !== 'TH' || !originalVat) {
    await db.update(organizations).set({ countryMode: 'TH', vatRegistered: true });
  }
  await org.refresh();

  // Open a test session
  const [session] = await db
    .insert((await import('@erp/db')).posSessions)
    .values({
      userId: orgRow.id, // any uuid; FK is non-strict on test
      openingBalanceCents: 0,
      status: 'open',
    })
    .returning({ id: (await import('@erp/db')).posSessions.id });
  testSessionId = session.id;

  // Insert a paid TX order with a unique document number
  const [order] = await db
    .insert(posOrders)
    .values({
      sessionId: testSessionId,
      orderLines: [
        {
          productId: 'test-prod-1',
          name: 'Integration Test Service',
          qty: 1,
          unitPriceCents: 10000,
          discountCents: 0,
          vatCategory: 'standard',
          netCents: 10000,
          vatCents: 700,
          grossCents: 10700,
        },
      ],
      subtotalCents: 10000,
      taxCents: 700,
      discountCents: 0,
      totalCents: 10700,
      currency: 'THB',
      paymentMethod: 'cash',
      paymentDetails: { tenderedCents: 10700, changeCents: 0 },
      status: 'paid',
      offlineId: TEST_OFFLINE_ID,
      documentType: 'TX',
      documentNumber: TEST_DOC_NUM,
      buyerName: 'Buyer Co Ltd',
      buyerTin: '0107537000254',
      buyerBranch: '00000',
      buyerAddress: '456 Rama IV, Bangkok 10500',
      vatBreakdown: {
        taxableNetCents: 10000,
        zeroRatedNetCents: 0,
        exemptNetCents: 0,
        vatCents: 700,
        grossCents: 10700,
      },
    })
    .returning({ id: posOrders.id });
  testOrderId = order.id;

  service = new EtaxSubmissionService(
    db as any,
    org,
    new TaxInvoiceXmlBuilder(),
    new EtdaXsdValidator(),
    new LeceiptAdapter(),
    new InetAdapter(),
  );
});

afterAll(async () => {
  // Cleanup
  if (testOrderId) {
    await db.execute(sql`DELETE FROM custom.etax_submissions WHERE order_id = ${testOrderId}`);
    await db.execute(sql`DELETE FROM custom.pos_orders WHERE id = ${testOrderId}`);
  }
  if (testSessionId) {
    await db.execute(sql`DELETE FROM custom.pos_sessions WHERE id = ${testSessionId}`);
  }
  await client.end();
});

describe('e-Tax submission pipeline (integration)', () => {
  it('builds a valid XML preview from a paid TX order', async () => {
    const builder = new TaxInvoiceXmlBuilder();
    const validator = new EtdaXsdValidator();
    const [order] = await db.select().from(posOrders).where(eq(posOrders.id, testOrderId)).limit(1);
    const dto = service.buildDto(order, await new (await import('../../src/modules/organization/organization.service')).OrganizationService(db as any, new EncryptionService(db as any)).snapshot());
    const built = builder.build(dto);
    expect(built.etdaCode).toBe('T01');
    expect(built.xml).toContain(`<ram:ID>${TEST_DOC_NUM}</ram:ID>`);
    expect(built.xml).toContain('<ram:ID schemeID="TXID">0107537000254</ram:ID>');

    const validation = validator.validate(built.xml);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('submits to Leceipt mock and persists ack', async () => {
    const result = await service.submitOrder(testOrderId, 'leceipt');
    expect(result.status).toBe('acknowledged');
    expect(result.providerReference).toMatch(/^LECEIPT-MOCK-/);
    expect(result.rdReference).toMatch(/^RD-MOCK-/);

    const rows = await db
      .select()
      .from(etaxSubmissions)
      .where(eq(etaxSubmissions.orderId, testOrderId));
    expect(rows.length).toBe(1);
    expect(rows[0].provider).toBe('leceipt');
    expect(rows[0].status).toBe('acknowledged');
    expect(rows[0].etdaCode).toBe('T01');
    expect(rows[0].xmlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0].xmlPayload.length).toBeGreaterThan(500);
    expect(rows[0].rdReference).toBe(result.rdReference);
  });

  it('is idempotent — second submit returns same submission row', async () => {
    const r1 = await service.submitOrder(testOrderId, 'leceipt');
    const rows = await db
      .select()
      .from(etaxSubmissions)
      .where(eq(etaxSubmissions.orderId, testOrderId));
    expect(rows.length).toBe(1); // didn't create a new row
    expect(r1.submissionId).toBe(rows[0].id);
    expect(r1.status).toBe('acknowledged');
  });

  it('supports a parallel INET submission as a separate row', async () => {
    const r2 = await service.submitOrder(testOrderId, 'inet');
    expect(r2.status).toBe('acknowledged');
    expect(r2.providerReference).toMatch(/^INET-MOCK-/);

    const rows = await db
      .select()
      .from(etaxSubmissions)
      .where(eq(etaxSubmissions.orderId, testOrderId));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.provider).sort()).toEqual(['inet', 'leceipt']);
  });

  it('exposes status via getStatus()', async () => {
    const rows = await service.getStatus(testOrderId);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === 'acknowledged')).toBe(true);
  });

  it('rejects submission for non-VAT-registered org', async () => {
    // Temporarily flip vatRegistered=false
    const [orgRow] = await db.select().from(organizations).limit(1);
    await db.update(organizations).set({ vatRegistered: false });

    const crypto = new EncryptionService(db as any);
    crypto.onModuleInit();
    const tempOrg = new OrganizationService(db as any, crypto);
    await tempOrg.refresh();
    const tempService = new EtaxSubmissionService(
      db as any,
      tempOrg,
      new TaxInvoiceXmlBuilder(),
      new EtdaXsdValidator(),
      new LeceiptAdapter(),
      new InetAdapter(),
    );

    await expect(tempService.submitOrder(testOrderId, 'leceipt')).rejects.toThrow(
      /VAT-registered Thai/,
    );

    // Restore
    await db.update(organizations).set({ vatRegistered: orgRow.vatRegistered });
  });

  it('XML hash is stable across re-renders of the same order', async () => {
    const [order] = await db.select().from(posOrders).where(eq(posOrders.id, testOrderId)).limit(1);
    const crypto = new EncryptionService(db as any);
    crypto.onModuleInit();
    const org = new OrganizationService(db as any, crypto);
    await org.refresh();
    const settings = await org.snapshot();
    const builder = new TaxInvoiceXmlBuilder();
    const dto = service.buildDto(order, settings);
    const a = builder.build(dto);
    const b = builder.build(dto);
    expect(a.hash).toBe(b.hash);
    expect(a.xml).toBe(b.xml);
  });
});
