import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { users, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';

/**
 * On boot, if custom.users is empty, create a default admin so the operator
 * can log in immediately. The password comes from `SEED_ADMIN_PASSWORD`; if
 * the env var isn't set we generate a random one and log it to the console
 * exactly once. The UI nags the operator to change it on first login.
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
    const username = process.env.SEED_ADMIN_USERNAME ?? 'admin';
    // No hardcoded fallback — generate a one-shot random password if the
    // operator didn't pin one via env. Logged below so it's recoverable from
    // the boot log; reset via the UI once they're in.
    const password = process.env.SEED_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
    const name = process.env.SEED_ADMIN_NAME ?? 'Default Admin';
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.db
      .insert(users)
      .values({ email, username, passwordHash, name, role: 'admin' });
    this.logger.warn(
      `╔════════════════════════════════════════════════════════════╗`,
    );
    this.logger.warn(
      `║  No users found — seeded default admin                     ║`,
    );
    this.logger.warn(
      `║    username: ${username.padEnd(46)}║`,
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
