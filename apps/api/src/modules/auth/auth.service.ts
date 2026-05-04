import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { auditEvents, users, refreshTokens, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * Drizzle's `db.transaction(async tx => ...)` callback receives a
 * `PgTransaction`, not the `Database` (PostgresJsDatabase) type. Both share
 * the same insert/update/select surface, so we widen with a structural alias
 * — services that work with both can accept `DbOrTx` and Drizzle's overloads
 * still resolve correctly.
 */
type DbOrTx = Pick<Database, 'select' | 'insert' | 'update' | 'delete'>;

/** Revocation reason taxonomy — kept narrow so audit + UI can switch on it cleanly. */
export type RevokeReason =
  | 'rotated'         // happy-path rotation; old token replaced by a new one
  | 'logout'          // user-initiated
  | 'expired'         // past expires_at when looked up
  | 'inactive_user'   // user account was deactivated
  | 'reused'          // the offending token in a reuse incident
  | 'family_revoked'; // sibling tokens revoked because the family was compromised

export type Role = 'admin' | 'manager' | 'accountant' | 'cashier';
const ALL_ROLES: Role[] = ['admin', 'manager', 'accountant', 'cashier'];

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export interface AuthUser {
  id: string;
  email: string | null;
  username: string | null;
  name: string;
  role: Role;
  isActive: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_DAYS = 7;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Sign up a new account. At least one of email or username must be provided.
   * First user ever → admin; everyone else → cashier by default.
   */
  async register(input: {
    email?: string | null;
    username?: string | null;
    password: string;
    name: string;
  }): Promise<AuthTokens> {
    const email = input.email?.trim().toLowerCase() || null;
    const username = input.username?.trim() || null;

    if (!email && !username) {
      throw new ConflictException('Provide an email or a username');
    }
    if (email && !EMAIL_RE.test(email)) {
      throw new ConflictException('Email looks invalid');
    }
    if (username && !USERNAME_RE.test(username)) {
      throw new ConflictException(
        'Username must be 3–32 characters, letters/digits/. _ - only',
      );
    }
    if (input.password.length < 4) {
      throw new ConflictException('Password must be at least 4 characters');
    }
    if (!input.name?.trim()) {
      throw new ConflictException('Name is required');
    }

    if (email) {
      const exists = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (exists.length > 0) throw new ConflictException('An account with that email already exists');
    }
    if (username) {
      const exists = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      if (exists.length > 0) throw new ConflictException('That username is taken');
    }

    const userCount = await this.db.select({ id: users.id }).from(users).limit(1);
    const role: Role = userCount.length === 0 ? 'admin' : 'cashier';

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const [row] = await this.db
      .insert(users)
      .values({ email, username, passwordHash, name: input.name.trim(), role })
      .returning();

    this.logger.log(`Registered ${username ?? email} as ${role}`);
    return this.issueTokens(row);
  }

  /**
   * Login by email OR username, plus password. Updates lastLoginAt.
   * The single `identifier` field looks up email when it contains '@', else username.
   * Both lookups also normalize the email to lowercase to match register-side hygiene.
   */
  async login(identifier: string, password: string): Promise<AuthTokens> {
    const id = identifier.trim();
    if (!id) throw new UnauthorizedException('Invalid credentials');

    const isEmail = id.includes('@');
    const where = isEmail
      ? eq(users.email, id.toLowerCase())
      : eq(users.username, id);
    const [row] = await this.db.select().from(users).where(where).limit(1);
    if (!row || !row.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await argon2.verify(row.passwordHash, password).catch(() => false);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.db
      .update(users)
      .set({ lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, row.id));
    return this.issueTokens(row);
  }

  /** Look up the user behind an access token. Throws if missing/invalid/inactive. */
  async me(userId: string): Promise<AuthUser> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row || !row.isActive) {
      throw new UnauthorizedException('Account inactive');
    }
    return this.toAuthUser(row);
  }

  /**
   * Rotate a refresh token. Reuse-detection model:
   *
   *   present a token →
   *     not found              → 401 (could be a typo; no signal)
   *     found, ALREADY revoked → REUSE INCIDENT
   *                              → revoke entire family (reason='family_revoked')
   *                              → mark this row reason='reused'
   *                              → audit event 'auth.token.reuse_detected'
   *                              → 401 with theft-flavoured message
   *     found, expired         → mark reason='expired'; 401
   *     found, user inactive   → mark reason='inactive_user' on entire family; 401
   *     found, active          → soft-revoke (reason='rotated'), issue new pair,
   *                              link old.replaced_by → new.id
   *
   * The whole rotation runs inside one transaction so a concurrent retry can't
   * race past the soft-revoke and rotate the same token twice.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    const tokenHash = this.hashToken(refreshToken);

    // Phase 1 — classify + commit happy-path / expiry / inactive in one tx.
    // Throwing here would roll back family-revoke writes; instead we return a
    // discriminated outcome and run the security side-effects in phase 2.
    type Outcome =
      | { kind: 'ok'; tokens: AuthTokens }
      | { kind: 'not_found' }
      | { kind: 'expired' }
      | { kind: 'inactive' }
      | {
          kind: 'reuse';
          userId: string;
          familyId: string;
          offendingTokenId: string;
        };

    const outcome: Outcome = await this.db.transaction(async (tx) => {
      // SELECT FOR UPDATE — two parallel /refresh calls with the same old
      // token serialise: the second one finds it already revoked, triggering
      // reuse-detection (the safer side of the race).
      const rows = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .for('update')
        .limit(1);
      const stored = rows[0];
      if (!stored) return { kind: 'not_found' };

      // Already-revoked → reuse incident. Don't touch anything here; phase 2
      // handles the family revoke + audit so the writes actually commit.
      if (stored.revokedAt) {
        return {
          kind: 'reuse',
          userId: stored.userId,
          familyId: stored.familyId,
          offendingTokenId: stored.id,
        };
      }

      if (stored.expiresAt < new Date()) {
        await tx
          .update(refreshTokens)
          .set({ revokedAt: new Date(), revokedReason: 'expired' })
          .where(eq(refreshTokens.id, stored.id));
        return { kind: 'expired' };
      }

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, stored.userId))
        .limit(1);
      if (!user || !user.isActive) {
        await this.revokeFamily(tx, stored.familyId, 'inactive_user', null);
        return { kind: 'inactive' };
      }

      // Happy path: mint new token, soft-revoke old with replaced_by pointer.
      const minted = await this.issueTokensInTx(tx, user, stored.familyId);
      await tx
        .update(refreshTokens)
        .set({
          revokedAt: new Date(),
          revokedReason: 'rotated',
          replacedBy: minted.row.id,
        })
        .where(eq(refreshTokens.id, stored.id));
      return { kind: 'ok', tokens: minted.tokens };
    });

    if (outcome.kind === 'ok') return outcome.tokens;
    if (outcome.kind === 'not_found') {
      throw new UnauthorizedException('Refresh token not recognised');
    }
    if (outcome.kind === 'expired') {
      throw new UnauthorizedException('Refresh token expired');
    }
    if (outcome.kind === 'inactive') {
      throw new UnauthorizedException('Account inactive');
    }

    // Phase 2 — reuse incident. Separate tx so the writes commit before we
    // throw the 401. Order matters: stamp the offender 'reused' FIRST so the
    // family revoke (which only touches active rows) doesn't accidentally
    // touch it. (We pass skipTokenId as belt-and-suspenders.)
    await this.db.transaction(async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ revokedReason: 'reused' })
        .where(eq(refreshTokens.id, outcome.offendingTokenId));
      await this.revokeFamily(
        tx,
        outcome.familyId,
        'family_revoked',
        outcome.offendingTokenId,
      );
      await this.writeAuditReuse(
        tx,
        outcome.userId,
        outcome.familyId,
        outcome.offendingTokenId,
      );
    });
    this.logger.warn(
      `[security] refresh-token reuse detected — userId=${outcome.userId} family=${outcome.familyId} — entire family revoked`,
    );
    throw new UnauthorizedException(
      'Token reuse detected — session revoked. Sign in again.',
    );
  }

  /**
   * Logout: soft-revoke the presented refresh token so it can't be rotated.
   * Idempotent — replaying with an unknown or already-revoked token still
   * returns ok:true. We deliberately don't trigger reuse-detection here:
   * logout is a "please end this session" signal, not a security claim.
   */
  async logout(refreshToken: string | undefined): Promise<{ ok: true }> {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.db
        .update(refreshTokens)
        .set({ revokedAt: new Date(), revokedReason: 'logout' })
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.revokedAt),
          ),
        );
    }
    return { ok: true };
  }

  /**
   * Revoke every still-active row in a family. Used both for reuse incidents
   * (kill compromised sessions) and for inactive-user lockouts. Pass
   * `skipTokenId` to leave one specific row untouched (so the caller can
   * stamp it with a more specific reason).
   */
  private async revokeFamily(
    tx: DbOrTx,
    familyId: string,
    reason: RevokeReason,
    skipTokenId: string | null,
  ): Promise<void> {
    const conds = [
      eq(refreshTokens.familyId, familyId),
      isNull(refreshTokens.revokedAt),
    ];
    if (skipTokenId) {
      conds.push(sql`${refreshTokens.id} <> ${skipTokenId}`);
    }
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(...conds));
  }

  private async writeAuditReuse(
    tx: DbOrTx,
    userId: string,
    familyId: string,
    offendingTokenId: string,
  ): Promise<void> {
    try {
      await tx.insert(auditEvents).values({
        aggregateType: 'auth.refresh_token',
        aggregateId: familyId,
        eventType: 'auth.token.reuse_detected',
        eventData: {
          userId,
          familyId,
          offendingTokenId,
          action: 'family_revoked',
        } as any,
        userId,
        userEmail: null,
        ipAddress: null,
      });
    } catch (e) {
      // Audit-write failure must NOT block the security response. Log + carry on.
      this.logger.error(`Failed to write reuse audit: ${(e as Error)?.message}`);
    }
  }

  // ─── helpers ─────────────────────────────────────────────────────────────
  /** Outside-tx issuance — used by login/register where a new family is started. */
  private async issueTokens(
    user: typeof users.$inferSelect,
    familyId?: string,
  ): Promise<AuthTokens> {
    const minted = await this.issueTokensInTx(this.db, user, familyId);
    return minted.tokens;
  }

  /**
   * Mint a fresh JWT + refresh token row inside the given tx (or root db).
   * Returns the row id alongside the public tokens so the rotate flow can
   * link old.replaced_by → new.id atomically with the soft-revoke.
   */
  private async issueTokensInTx(
    tx: DbOrTx,
    user: typeof users.$inferSelect,
    familyId?: string,
  ): Promise<{ tokens: AuthTokens; row: { id: string } }> {
    const role = (ALL_ROLES.includes(user.role as Role) ? user.role : 'cashier') as Role;
    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        email: user.email,
        username: user.username,
        role,
        name: user.name,
      },
      { secret: this.accessSecret(), expiresIn: ACCESS_TTL_SECONDS },
    );

    const refreshTokenRaw = randomBytes(48).toString('base64url');
    const tokenHash = this.hashToken(refreshTokenRaw);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    const family =
      familyId ?? (globalThis as any).crypto?.randomUUID?.() ?? randomBytes(16).toString('hex');
    const [inserted] = await tx
      .insert(refreshTokens)
      .values({
        userId: user.id,
        tokenHash,
        familyId: family,
        expiresAt,
      })
      .returning({ id: refreshTokens.id });

    return {
      tokens: {
        accessToken,
        refreshToken: refreshTokenRaw,
        user: this.toAuthUser(user),
      },
      row: { id: inserted.id },
    };
  }

  private toAuthUser(row: typeof users.$inferSelect): AuthUser {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      name: row.name,
      role: (ALL_ROLES.includes(row.role as Role) ? row.role : 'cashier') as Role,
      isActive: row.isActive,
    };
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private accessSecret(): string {
    const s = process.env.JWT_ACCESS_SECRET;
    if (!s || s.length < 16) throw new Error('JWT_ACCESS_SECRET must be set (≥16 chars)');
    return s;
  }
}
