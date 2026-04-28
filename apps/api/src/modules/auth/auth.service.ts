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
import { eq } from 'drizzle-orm';
import { users, refreshTokens, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

export type Role = 'admin' | 'manager' | 'accountant' | 'cashier';
const ALL_ROLES: Role[] = ['admin', 'manager', 'accountant', 'cashier'];

export interface AuthUser {
  id: string;
  email: string;
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

  /** Sign up a new account. First user ever → admin; everyone else → cashier by default. */
  async register(input: { email: string; password: string; name: string }): Promise<AuthTokens> {
    const email = input.email.trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      throw new ConflictException('Email looks invalid');
    }
    if (input.password.length < 4) {
      throw new ConflictException('Password must be at least 4 characters');
    }
    if (!input.name?.trim()) {
      throw new ConflictException('Name is required');
    }

    const existing = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      throw new ConflictException('An account with that email already exists');
    }

    const userCount = await this.db.select({ id: users.id }).from(users).limit(1);
    const role: Role = userCount.length === 0 ? 'admin' : 'cashier';

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const [row] = await this.db
      .insert(users)
      .values({ email, passwordHash, name: input.name.trim(), role })
      .returning();

    this.logger.log(`Registered ${email} as ${role}`);
    return this.issueTokens(row);
  }

  /** Email + password login. Updates lastLoginAt. */
  async login(email: string, password: string): Promise<AuthTokens> {
    const normalized = email.trim().toLowerCase();
    const [row] = await this.db.select().from(users).where(eq(users.email, normalized)).limit(1);
    if (!row || !row.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const ok = await argon2.verify(row.passwordHash, password).catch(() => false);
    if (!ok) {
      throw new UnauthorizedException('Invalid email or password');
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

  /** Rotate a refresh token: validate it, invalidate it, issue a new pair. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    const tokenHash = this.hashToken(refreshToken);
    const [stored] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (!stored) throw new UnauthorizedException('Refresh token not recognised');
    if (stored.expiresAt < new Date()) {
      await this.db.delete(refreshTokens).where(eq(refreshTokens.id, stored.id));
      throw new UnauthorizedException('Refresh token expired');
    }
    const [user] = await this.db.select().from(users).where(eq(users.id, stored.userId)).limit(1);
    if (!user || !user.isActive) {
      await this.db.delete(refreshTokens).where(eq(refreshTokens.id, stored.id));
      throw new UnauthorizedException('Account inactive');
    }
    // Rotation: invalidate old token, issue new pair with the same family id.
    await this.db.delete(refreshTokens).where(eq(refreshTokens.id, stored.id));
    return this.issueTokens(user, stored.familyId);
  }

  /** Logout: drop the presented refresh token (if any) so it can't be rotated again. */
  async logout(refreshToken: string | undefined): Promise<{ ok: true }> {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    }
    return { ok: true };
  }

  // ─── helpers ─────────────────────────────────────────────────────────────
  private async issueTokens(user: typeof users.$inferSelect, familyId?: string): Promise<AuthTokens> {
    const role = (ALL_ROLES.includes(user.role as Role) ? user.role : 'cashier') as Role;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role, name: user.name },
      { secret: this.accessSecret(), expiresIn: ACCESS_TTL_SECONDS },
    );

    const refreshTokenRaw = randomBytes(48).toString('base64url');
    const tokenHash = this.hashToken(refreshTokenRaw);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
    const family =
      familyId ?? (globalThis as any).crypto?.randomUUID?.() ?? randomBytes(16).toString('hex');
    await this.db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash,
      familyId: family,
      expiresAt,
    });

    return {
      accessToken,
      refreshToken: refreshTokenRaw,
      user: this.toAuthUser(user),
    };
  }

  private toAuthUser(row: typeof users.$inferSelect): AuthUser {
    return {
      id: row.id,
      email: row.email,
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
