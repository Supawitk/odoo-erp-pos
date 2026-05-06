import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { users, refreshTokens, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import type { Role } from './auth.service';

const ROLES: Role[] = ['admin', 'manager', 'accountant', 'cashier'];

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async list() {
    const rows = await this.db.select().from(users).orderBy(asc(users.createdAt));
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      username: r.username,
      name: r.name,
      role: r.role,
      branchCode: r.branchCode ?? null,
      isActive: r.isActive,
      lastLoginAt: r.lastLoginAt,
      createdAt: r.createdAt,
    }));
  }

  async listByBranch(branchCode: string) {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.branchCode, branchCode))
      .orderBy(asc(users.name));
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      username: r.username,
      name: r.name,
      role: r.role,
      branchCode: r.branchCode ?? null,
      isActive: r.isActive,
      lastLoginAt: r.lastLoginAt,
      createdAt: r.createdAt,
    }));
  }

  async setBranch(id: string, branchCode: string | null) {
    if (branchCode !== null && !/^\d{5}$/.test(branchCode)) {
      throw new BadRequestException('branch_code must be 5 digits or null');
    }
    const [row] = await this.db
      .update(users)
      .set({ branchCode, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  async setRole(id: string, role: string) {
    if (!ROLES.includes(role as Role)) {
      throw new BadRequestException(`role must be one of ${ROLES.join(', ')}`);
    }
    const [row] = await this.db
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  async setActive(id: string, isActive: boolean) {
    const [row] = await this.db
      .update(users)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundException('User not found');
    if (!isActive) {
      // Disabling a user must invalidate every active refresh token they hold.
      await this.db.delete(refreshTokens).where(eq(refreshTokens.userId, id));
    }
    return row;
  }

  async resetPassword(id: string, newPassword: string) {
    if (!newPassword || newPassword.length < 4) {
      throw new BadRequestException('Password must be at least 4 characters');
    }
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    const [row] = await this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (!row) throw new NotFoundException('User not found');
    // Force re-login everywhere on password change.
    await this.db.delete(refreshTokens).where(eq(refreshTokens.userId, id));
    return { ok: true };
  }
}
