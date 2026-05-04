/**
 * Refresh-token reuse-detection integration test.
 *
 * Verifies the "leaked token replay" path end-to-end against the live local
 * Postgres:
 *
 *   1. Login → token A1 active
 *   2. Refresh A1 → A1 soft-revoked (reason='rotated', replaced_by=A2.id),
 *                   A2 active
 *   3. Refresh A2 → A2 soft-revoked, A3 active
 *   4. Replay A1  → REUSE INCIDENT
 *                   - A1 stamped reason='reused'
 *                   - A2 (already revoked='rotated') untouched (skipTokenId)
 *                   - A3 stamped reason='family_revoked'
 *                   - audit_events row written: aggregateType=auth.refresh_token,
 *                     eventType=auth.token.reuse_detected
 *   5. Refresh A3 (the previously-active head) → 401 because it was just killed
 *      by the family revoke.
 *
 * Plus three sanity checks:
 *   - logout soft-revokes (reason='logout'), idempotent
 *   - cleanup cron purges only past-grace rows
 *   - unknown token → 401 with 'not recognised', NO family touched
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../../src/modules/auth/auth.service';
import { RefreshTokenCleanupService } from '../../src/modules/auth/refresh-token-cleanup.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const CONN =
  process.env.DATABASE_URL ||
  'postgresql://admin:***SCRUBBED***@localhost:5432/odoo';

let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;
let auth: AuthService;
let cleanup: RefreshTokenCleanupService;
let TEST_USER_ID = '';
let TEST_USERNAME = '';

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET =
    process.env.JWT_ACCESS_SECRET ?? 'integration-test-secret-please-rotate-32chars';

  client = postgres(CONN, { max: 30 });
  db = drizzle(client) as unknown as ReturnType<typeof drizzle>;
  const jwt = new JwtService({});
  auth = new AuthService(db as any, jwt);
  cleanup = new RefreshTokenCleanupService(db as any);

  TEST_USERNAME = `reuse_test_${Date.now()}`;
  const reg = await auth.register({
    username: TEST_USERNAME,
    password: 'test-password-1234',
    name: 'Reuse Test',
  });
  TEST_USER_ID = reg.user.id;
}, 30_000);

afterAll(async () => {
  await client`DELETE FROM custom.audit_events WHERE user_id = ${TEST_USER_ID}`;
  await client`DELETE FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}`;
  await client`DELETE FROM custom.users WHERE id = ${TEST_USER_ID}`;
  await client?.end();
}, 15_000);

describe('Refresh-token reuse detection', () => {
  it('happy-path rotation soft-revokes old, links replaced_by → new', async () => {
    // Wipe stale tokens from registration / earlier tests so the assertions
    // below scope to exactly this scenario.
    await client`DELETE FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}`;
    const a1 = await auth.login(TEST_USERNAME, 'test-password-1234');
    const a2 = await auth.refresh(a1.refreshToken);

    const rA1 = await client`
      SELECT revoked_reason, replaced_by, family_id
        FROM custom.refresh_tokens WHERE token_hash = ${sha256(a1.refreshToken)}
    `;
    const rA2 = await client`
      SELECT revoked_at, family_id
        FROM custom.refresh_tokens WHERE token_hash = ${sha256(a2.refreshToken)}
    `;
    expect(rA1[0].revoked_reason).toBe('rotated');
    expect(rA1[0].replaced_by).toBeTruthy();
    expect(rA2[0].revoked_at).toBeNull();
    expect(rA2[0].family_id).toBe(rA1[0].family_id);
  });

  it('replaying a rotated token revokes the entire family + writes audit event', async () => {
    // Reset to a clean family
    await client`DELETE FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}`;
    await client`DELETE FROM custom.audit_events WHERE user_id = ${TEST_USER_ID}`;

    const a1 = await auth.login(TEST_USERNAME, 'test-password-1234');
    const a2 = await auth.refresh(a1.refreshToken);
    const a3 = await auth.refresh(a2.refreshToken);

    // Now replay the long-revoked A1 — this is the leak.
    let caught: any = null;
    try {
      await auth.refresh(a1.refreshToken);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught?.message ?? '')).toMatch(/reuse|sign in/i);

    // Inspect each row by its token hash — created_at ties make ORDER BY non-deterministic
    const lookup = async (raw: string) => {
      const r = await client`
        SELECT revoked_at IS NOT NULL AS revoked, revoked_reason
          FROM custom.refresh_tokens WHERE token_hash = ${sha256(raw)}
      `;
      return r[0];
    };
    const rA1 = await lookup(a1.refreshToken);
    const rA2 = await lookup(a2.refreshToken);
    const rA3 = await lookup(a3.refreshToken);
    expect(rA1.revoked).toBe(true);
    expect(rA1.revoked_reason).toBe('reused');
    expect(rA2.revoked).toBe(true);
    expect(rA2.revoked_reason).toBe('rotated');
    expect(rA3.revoked).toBe(true);
    expect(rA3.revoked_reason).toBe('family_revoked');

    // Audit event landed
    const audits = await client`
      SELECT event_type, aggregate_type
        FROM custom.audit_events
       WHERE user_id = ${TEST_USER_ID}
         AND event_type = 'auth.token.reuse_detected'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0].aggregate_type).toBe('auth.refresh_token');

    // Subsequently, the previously-active A3 is also dead.
    let caught2: any = null;
    try {
      await auth.refresh(a3.refreshToken);
    } catch (e) {
      caught2 = e;
    }
    expect(caught2).toBeTruthy();
  });

  it('logout soft-revokes; second logout with the same token is a no-op', async () => {
    await client`DELETE FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}`;
    const a1 = await auth.login(TEST_USERNAME, 'test-password-1234');
    await auth.logout(a1.refreshToken);

    const rows = await client`
      SELECT revoked_at IS NOT NULL AS revoked, revoked_reason
        FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked).toBe(true);
    expect(rows[0].revoked_reason).toBe('logout');

    // Second logout — idempotent, doesn't bump the row again to a different reason.
    await auth.logout(a1.refreshToken);
    const after = await client`
      SELECT revoked_reason FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}
    `;
    expect(after[0].revoked_reason).toBe('logout');

    // Refresh with the logged-out token → 'not recognised'-ish UnauthorizedException
    // (the soft-revoked row IS in the DB, so reuse-detection actually triggers — and
    // that's the right thing: a logged-out token replayed IS a re-use signal).
    let caught: any = null;
    try {
      await auth.refresh(a1.refreshToken);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
  });

  it('unknown / typo refresh token → 401, no family touched', async () => {
    await client`DELETE FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}`;
    await auth.login(TEST_USERNAME, 'test-password-1234');
    const before = await client`
      SELECT count(*)::int AS n FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}
    `;

    let caught: any = null;
    try {
      await auth.refresh('totally-not-a-real-token');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(String(caught?.message)).toMatch(/not recognised/i);

    // The active row is untouched
    const after = await client`
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE revoked_at IS NULL) AS active
        FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}
    `;
    expect(after[0].n).toBe(before[0].n);
    expect(Number(after[0].active)).toBe(1);
  });

  it('cleanup cron purges past-grace rows only', async () => {
    await client`DELETE FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID}`;

    // Two stale rows, two fresh rows
    await client`
      INSERT INTO custom.refresh_tokens (user_id, token_hash, family_id, expires_at, created_at)
      VALUES
        (${TEST_USER_ID}, 'h-old-1', gen_random_uuid(), now() - interval '60 days', now() - interval '60 days'),
        (${TEST_USER_ID}, 'h-old-2', gen_random_uuid(), now() - interval '45 days', now() - interval '45 days'),
        (${TEST_USER_ID}, 'h-new-1', gen_random_uuid(), now() + interval '7 days',  now()),
        (${TEST_USER_ID}, 'h-new-2', gen_random_uuid(), now() - interval '5 days',  now() - interval '12 days')
    `;
    const result = await cleanup.runOnce(30); // grace=30d
    expect(result.deleted).toBe(2);

    const remaining = await client`
      SELECT token_hash FROM custom.refresh_tokens WHERE user_id = ${TEST_USER_ID} ORDER BY token_hash
    `;
    expect(remaining.map((r: any) => r.token_hash)).toEqual(['h-new-1', 'h-new-2']);
  });
});
