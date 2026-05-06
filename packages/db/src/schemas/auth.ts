import {
  pgSchema,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  varchar,
} from 'drizzle-orm/pg-core';

export const customSchema = pgSchema('custom');

// Users & Authentication.
//
// Identity model: at least ONE of (email, username) must be present (DB CHECK
// constraint). Both columns have partial unique indexes so they're unique when
// set and unconstrained when null. Login accepts either.
export const users = customSchema.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email'),
  username: text('username'),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull().default('cashier'), // admin, manager, cashier, accountant
  odooUserId: integer('odoo_user_id'),
  /** Branch the user is primarily assigned to. NULL = not assigned to a specific branch. */
  branchCode: varchar('branch_code', { length: 5 }),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaSecret: text('mfa_secret'), // encrypted with pgcrypto
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Refresh tokens — soft-revoke model for theft detection.
 *
 * Every refresh rotates the active token: the old row's `revoked_at` is set
 * to now() with `revoked_reason='rotated'` and `replaced_by` points at the
 * new row. The token chain forms a linked list within a `family_id`.
 *
 * If a refresh request presents a token that is ALREADY revoked, that's a
 * leaked-token replay. The handler revokes every row in the family (reason
 * `family_revoked`) and writes an audit_events row so the operator sees
 * "session compromised" in security logs.
 *
 * Cleanup cron purges rows where expires_at < now() − 30d so the table
 * doesn't grow forever. The 30-day grace is for forensic queries.
 */
export const refreshTokens = customSchema.table('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  familyId: uuid('family_id').notNull(),
  deviceId: text('device_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  /** When the token was invalidated. NULL = currently active. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** Why: rotated | reused | logout | family_revoked | expired | inactive_user */
  revokedReason: text('revoked_reason'),
  /** Forward pointer for the rotation chain. */
  replacedBy: uuid('replaced_by'),
});
