/**
 * Phase 1 — pgcrypto field encryption integration tests.
 *
 * Runs against the LIVE local Postgres. Uses a fresh ENCRYPTION_MASTER_KEY
 * from .env and exercises encrypt/decrypt round-trip + hash determinism +
 * lookup-by-hash + null handling.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as fc from 'fast-check';
import { EncryptionService } from '../../src/modules/../shared/infrastructure/crypto/encryption.service';

// Reach the service via Drizzle (skip Nest DI for this layer test).
const CONN =
  process.env.DATABASE_URL || 'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';

let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;
let service: EncryptionService;

beforeAll(async () => {
  client = postgres(CONN);
  db = drizzle(client);
  // Force the env key for the test (no Nest container).
  process.env.ENCRYPTION_MASTER_KEY =
    process.env.ENCRYPTION_MASTER_KEY ||
    'dev_encryption_master_key_replace_in_prod_32bytes';
  service = new EncryptionService(db as any);
  service.onModuleInit();
});

afterAll(async () => {
  await client.end();
});

describe('EncryptionService', () => {
  it('round-trips a TIN through encrypt → decrypt', async () => {
    const tin = '0105551234567';
    const ciphertext = await service.encrypt(tin);
    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(ciphertext!.length).toBeGreaterThan(0);
    // Ciphertext bytes must NOT contain the plaintext.
    expect(ciphertext!.toString('utf8')).not.toContain(tin);

    const decrypted = await service.decrypt(ciphertext);
    expect(decrypted).toBe(tin);
  });

  it('produces a different ciphertext on every encrypt (random IV)', async () => {
    const tin = '0105551234567';
    const c1 = await service.encrypt(tin);
    const c2 = await service.encrypt(tin);
    expect(Buffer.compare(c1!, c2!)).not.toBe(0);
    // But both decrypt to the same plaintext.
    expect(await service.decrypt(c1)).toBe(tin);
    expect(await service.decrypt(c2)).toBe(tin);
  });

  it('hash is deterministic and stable across runs', () => {
    const tin = '0105551234567';
    const h1 = service.hash(tin);
    const h2 = service.hash(tin);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // Known-good sha256 for this exact string (verified separately).
    expect(h1).toBe(
      'cf53e19c5040408611d79284b5b6b1af105f9d44c9c73203db2a9ccd8e946366',
    );
  });

  it('hash differs for different TINs', () => {
    const a = service.hash('0105551234567');
    const b = service.hash('0107537000254');
    expect(a).not.toBe(b);
  });

  it('returns null for null/empty/undefined input', async () => {
    expect(await service.encrypt(null)).toBeNull();
    expect(await service.encrypt(undefined)).toBeNull();
    expect(await service.encrypt('')).toBeNull();
    expect(await service.decrypt(null)).toBeNull();
    expect(await service.decrypt(undefined)).toBeNull();
    expect(service.hash(null)).toBeNull();
    expect(service.hash('')).toBeNull();
  });

  it('encryptAndHash returns matched pair', async () => {
    const tin = '0107537000254';
    const { encrypted, hash } = await service.encryptAndHash(tin);
    expect(encrypted).toBeInstanceOf(Buffer);
    expect(await service.decrypt(encrypted)).toBe(tin);
    expect(hash).toBe(service.hash(tin));
  });

  it('property: any string round-trips encrypt → decrypt', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }),
        async (s) => {
          const c = await service.encrypt(s);
          const back = await service.decrypt(c);
          return back === s;
        },
      ),
      { numRuns: 10 }, // network round-trips per assertion → keep small
    );
  });

  it('property: hash is collision-resistant on small Thai-TIN-shaped strings', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 13, maxLength: 13 }),
        fc.string({ minLength: 13, maxLength: 13 }),
        (a, b) => {
          if (a === b) return true;
          return service.hash(a) !== service.hash(b);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('decrypts the live backfill (sanity check the migration ran)', async () => {
    // The migration encrypted every existing partners.tin with the same key.
    // Pull one row back, decrypt, and assert it matches plaintext.
    const rows = await db.execute<{ tin: string; tin_encrypted: Buffer }>(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('drizzle-orm').sql`
        SELECT tin, tin_encrypted FROM custom.partners
        WHERE tin IS NOT NULL AND tin_encrypted IS NOT NULL LIMIT 1
      `,
    );
    const arr: any[] = (rows as any).rows ?? (rows as any) ?? [];
    if (arr.length === 0) {
      // No backfill data — skip (acceptable in a fresh DB).
      return;
    }
    const decoded = await service.decrypt(arr[0].tin_encrypted);
    expect(decoded).toBe(arr[0].tin);
  });
});
