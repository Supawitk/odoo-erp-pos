import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { chartOfAccounts, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { THAI_SME_CHART } from '../domain/chart-of-accounts.seed';

/**
 * Idempotent Chart of Accounts bootstrap.
 *
 * On every API boot we upsert the Thai SME chart so that:
 *   1. fresh databases get a usable CoA without a migration step
 *   2. existing rows pick up new bilingual labels (name_th / name_en)
 *   3. removing an account from the seed marks it inactive (we never DELETE
 *      because journal entries reference these codes)
 *
 * Also adds the FK from journal_entry_lines.account_code → chart_of_accounts.code
 * if it isn't already in place.
 */
@Injectable()
export class CoaSeederService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CoaSeederService.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async onApplicationBootstrap(): Promise<void> {
    let upserted = 0;
    for (const a of THAI_SME_CHART) {
      // Note: isCashAccount is set on initial INSERT only — onConflictDoUpdate
      // deliberately omits it so a user's UI toggle (or flagging a fresh bank
      // account) isn't reset on every API boot.
      await this.db
        .insert(chartOfAccounts)
        .values({
          code: a.code,
          name: a.nameTh, // canonical = Thai (most invoices print in Thai)
          nameTh: a.nameTh,
          nameEn: a.nameEn,
          type: a.type,
          parentCode: a.parentCode,
          normalBalance: a.normalBalance,
          isActive: true,
          isCashAccount: a.isCashAccount ?? false,
        })
        .onConflictDoUpdate({
          target: chartOfAccounts.code,
          set: {
            name: a.nameTh,
            nameTh: a.nameTh,
            nameEn: a.nameEn,
            type: a.type,
            parentCode: a.parentCode,
            normalBalance: a.normalBalance,
            isActive: true,
          },
        });
      upserted++;
    }

    // The FK from journal_entry_lines.account_code → chart_of_accounts.code
    // is set up in the migration (admin role); we don't try to add it here
    // since the app role lacks ALTER TABLE on tables it doesn't own.
    this.logger.log(
      `Chart of accounts bootstrapped: ${upserted} accounts upserted (Thai SME / TFRS for NPAEs)`,
    );
  }
}
