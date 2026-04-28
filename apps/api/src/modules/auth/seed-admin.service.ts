import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as argon2 from 'argon2';
import { users, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * On boot, if custom.users is empty, create a default admin so the operator
 * can log in immediately. Default credentials are intentionally weak (1234)
 * so they're easy to remember; the UI nags them to change it on first login.
 *
 * Once the table has any user, this no-ops — never overwrites existing data.
 */
@Injectable()
export class SeedAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedAdminService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async onApplicationBootstrap() {
    const existing = await this.db.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) return;

    const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@local').toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD ?? '1234';
    const name = process.env.SEED_ADMIN_NAME ?? 'Default Admin';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.db
      .insert(users)
      .values({ email, passwordHash, name, role: 'admin' });
    this.logger.warn(
      `╔════════════════════════════════════════════════════════════╗`,
    );
    this.logger.warn(
      `║  No users found — seeded default admin                     ║`,
    );
    this.logger.warn(
      `║    email:    ${email.padEnd(46)}║`,
    );
    this.logger.warn(
      `║    password: ${password.padEnd(46)}║`,
    );
    this.logger.warn(
      `║  CHANGE THE PASSWORD IMMEDIATELY from Settings → Users.    ║`,
    );
    this.logger.warn(
      `╚════════════════════════════════════════════════════════════╝`,
    );
  }
}
