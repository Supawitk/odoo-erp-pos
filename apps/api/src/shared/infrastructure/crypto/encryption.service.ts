import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../database/database.module';

/**
 * Field-level encryption via Postgres pgcrypto. Pattern:
 *
 *   - encrypt(plaintext) → bytea ciphertext, stored in `*_encrypted` column
 *   - hash(plaintext)    → hex sha256 string, stored in `*_hash` column
 *                          for indexed equality lookup (encrypted blobs aren't queryable)
 *   - decrypt(cipher)    → plaintext, called only at the application layer
 *
 * Why this pattern (and NOT app-side AES-GCM):
 *   pgcrypto-backed encryption keeps the ciphertext truly DB-resident — even a
 *   stolen pg_dump is opaque without ENCRYPTION_MASTER_KEY. Application-layer
 *   AES-GCM with the same key would have identical security properties but
 *   adds an extra deserialise step on every read. Starting with pgcrypto
 *   removes one moving part; we can swap to app-side later if needed.
 *
 * Why a separate sha256 hash column:
 *   pgp_sym_encrypt is non-deterministic (random IV) → equality lookup on
 *   ciphertext doesn't work. Hash is deterministic. Hash leaks "two records
 *   share the same TIN" but not the TIN itself; acceptable trade-off for
 *   indexed lookups (e.g. find all orders for a known buyer TIN).
 *
 * Why NOT encrypt email/phone:
 *   Application reads them on every login + audit log line + receipt. The
 *   plan calls out TIN/bank/salary specifically. Email/phone we keep
 *   plaintext + hash on auth side via argon2 (already done).
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly log = new Logger(EncryptionService.name);
  private key: string;

  constructor(@Inject(DRIZZLE) private readonly db: Database) {
    this.key = process.env.ENCRYPTION_MASTER_KEY ?? '';
  }

  onModuleInit() {
    if (!this.key) {
      this.log.error(
        'ENCRYPTION_MASTER_KEY not set — field encryption disabled. ' +
          'Set ENCRYPTION_MASTER_KEY in .env to a 32-byte secret (openssl rand -hex 32).',
      );
      return;
    }
    if (this.key.length < 16) {
      this.log.warn(
        `ENCRYPTION_MASTER_KEY is only ${this.key.length} chars — recommend ≥32`,
      );
    }
    this.log.log(`Field encryption enabled (key length=${this.key.length})`);
  }

  /** True if the service is operational (key configured). */
  isEnabled(): boolean {
    return this.key.length > 0;
  }

  /**
   * Encrypt a plaintext value to a Buffer for storage in a `bytea` column.
   * Returns null when input is null/empty so callers can skip optional fields.
   */
  async encrypt(plaintext: string | null | undefined): Promise<Buffer | null> {
    if (!plaintext) return null;
    if (!this.isEnabled()) {
      throw new Error('EncryptionService not configured (ENCRYPTION_MASTER_KEY missing)');
    }
    const rows = await this.db.execute<{ ciphertext: Buffer }>(
      sql`SELECT pgp_sym_encrypt(${plaintext}, ${this.key}) AS ciphertext`,
    );
    const arr: any[] = (rows as any).rows ?? (rows as any) ?? [];
    return arr[0]?.ciphertext ?? null;
  }

  /**
   * Decrypt a bytea Buffer back to plaintext. Returns null when input is null.
   * Throws if the ciphertext was encrypted under a different key.
   */
  async decrypt(ciphertext: Buffer | null | undefined): Promise<string | null> {
    if (!ciphertext) return null;
    if (!this.isEnabled()) {
      throw new Error('EncryptionService not configured (ENCRYPTION_MASTER_KEY missing)');
    }
    const rows = await this.db.execute<{ plaintext: string }>(
      sql`SELECT pgp_sym_decrypt(${ciphertext}::bytea, ${this.key}) AS plaintext`,
    );
    const arr: any[] = (rows as any).rows ?? (rows as any) ?? [];
    return arr[0]?.plaintext ?? null;
  }

  /**
   * Deterministic sha256 hex hash for indexed equality lookup. Returns null
   * for empty input. Stable: hash(x) === hash(x) every time.
   *
   * Note: hashing is NOT keyed (no HMAC). An attacker with a TIN candidate
   * list could check membership via rainbow lookup. For TIN this is
   * acceptable because TIN format is constrained (13 digits, mod-11 valid)
   * and the merchant's compliance posture treats TIN as semi-public
   * (it appears on every printed tax invoice). For more sensitive fields,
   * use HMAC-SHA256 with a separate hash key.
   */
  hash(plaintext: string | null | undefined): string | null {
    if (!plaintext) return null;
    return require('crypto')
      .createHash('sha256')
      .update(plaintext, 'utf8')
      .digest('hex');
  }

  /**
   * Convenience: encrypt + hash in one call (one round-trip + local hash).
   */
  async encryptAndHash(
    plaintext: string | null | undefined,
  ): Promise<{ encrypted: Buffer | null; hash: string | null }> {
    return {
      encrypted: await this.encrypt(plaintext),
      hash: this.hash(plaintext),
    };
  }
}
