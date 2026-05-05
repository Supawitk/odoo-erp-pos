import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { organizations, type Database, type CountryMode } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { EncryptionService } from '../../shared/infrastructure/crypto/encryption.service';
import {
  type FeatureFlags,
  DEFAULT_FEATURE_FLAGS,
  normaliseFeatureFlags,
} from './feature-flags';

export interface OrgSnapshot {
  id: string;
  countryMode: CountryMode;
  vatRegistered: boolean;
  currency: string;
  locale: string;
  timezone: string;
  sellerName: string;
  sellerTin: string | null;
  sellerBranch: string;
  sellerAddress: string;
  vatRate: number;
  defaultVatMode: 'inclusive' | 'exclusive';
  abbreviatedTaxInvoiceCapCents: number;
  promptpayBillerId: string | null;
  /** 🇹🇭 PP.30 (2026-03-01) PromptPay refund channel — RD pushes VAT refunds here. */
  promptpayRefundId: string | null;
  fxSource: string;
  defaultBankChargeAccount: string;
  featureFlags: FeatureFlags;
}

export type OrgPatch = Partial<
  Omit<OrgSnapshot, 'id' | 'vatRate' | 'featureFlags'> & {
    vatRate: number;
    featureFlags: Partial<FeatureFlags>;
  }
>;

/**
 * Singleton org config, cached in-memory. Cache invalidates on update().
 * When `countryMode === 'GENERIC'`, callers must avoid Thai-specific code
 * paths (TIN check, PP.30 filing, PromptPay QR, etc.).
 */
@Injectable()
export class OrganizationService implements OnModuleInit {
  private readonly logger = new Logger(OrganizationService.name);
  private cache: OrgSnapshot | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: EncryptionService,
  ) {}

  async onModuleInit() {
    await this.snapshot();
    this.logger.log(
      `Org loaded: mode=${this.cache?.countryMode} vat=${this.cache?.vatRegistered} currency=${this.cache?.currency}`,
    );
  }

  async snapshot(): Promise<OrgSnapshot> {
    if (this.cache) return this.cache;
    const rows = await this.db.select().from(organizations).limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(
        'organization row not seeded — run the migration or INSERT a default row',
      );
    }
    this.cache = mapRow(rows[0]);
    return this.cache;
  }

  async refresh(): Promise<OrgSnapshot> {
    this.cache = null;
    return this.snapshot();
  }

  isThai(): boolean {
    return this.cache?.countryMode === 'TH';
  }

  async update(patch: OrgPatch): Promise<OrgSnapshot> {
    const current = await this.snapshot();
    const next: Record<string, unknown> = { updatedAt: new Date() };

    if (patch.countryMode !== undefined) {
      if (patch.countryMode !== 'TH' && patch.countryMode !== 'GENERIC') {
        throw new Error(`invalid countryMode ${patch.countryMode}`);
      }
      next.countryMode = patch.countryMode;
    }
    if (patch.vatRegistered !== undefined) next.vatRegistered = patch.vatRegistered;
    if (patch.currency !== undefined) next.currency = patch.currency;
    if (patch.locale !== undefined) next.locale = patch.locale;
    if (patch.timezone !== undefined) next.timezone = patch.timezone;
    if (patch.sellerName !== undefined) next.sellerName = patch.sellerName;
    if (patch.sellerTin !== undefined) {
      next.sellerTin = patch.sellerTin;
      // Dual-write: ciphertext alongside plaintext (transitional). EncryptionService
      // returns null when the input is null, so re-encrypting on every clear is safe.
      next.sellerTinEncrypted = await this.crypto.encrypt(patch.sellerTin);
    }
    if (patch.sellerBranch !== undefined) next.sellerBranch = patch.sellerBranch;
    if (patch.sellerAddress !== undefined) next.sellerAddress = patch.sellerAddress;
    if (patch.vatRate !== undefined) next.vatRate = String(patch.vatRate);
    if (patch.defaultVatMode !== undefined) next.defaultVatMode = patch.defaultVatMode;
    if (patch.abbreviatedTaxInvoiceCapCents !== undefined) {
      next.abbreviatedTaxInvoiceCapCents = patch.abbreviatedTaxInvoiceCapCents;
    }
    if (patch.promptpayBillerId !== undefined) next.promptpayBillerId = patch.promptpayBillerId;
    if (patch.promptpayRefundId !== undefined) {
      // Accept null/empty (clear), 13-digit TIN, or E.164 mobile (+...). The
      // PP.30 form will display whatever's here verbatim under "ช่องทางคืนเงิน".
      const v = patch.promptpayRefundId;
      if (v != null && v !== '') {
        const isThirteenDigit = /^\d{13}$/.test(v);
        const isE164Mobile = /^\+\d{10,15}$/.test(v);
        if (!isThirteenDigit && !isE164Mobile) {
          throw new BadRequestException(
            'promptpayRefundId must be a 13-digit TIN or an E.164 mobile (+66...)',
          );
        }
      }
      next.promptpayRefundId = v || null;
    }
    if (patch.fxSource !== undefined) next.fxSource = patch.fxSource;
    if (patch.defaultBankChargeAccount !== undefined) {
      // Validate the code looks like a real CoA code; defence in depth on top of
      // the FK that the journal-line writer will hit.
      if (!/^\d{4}$/.test(patch.defaultBankChargeAccount)) {
        throw new BadRequestException('defaultBankChargeAccount must be a 4-digit account code');
      }
      next.defaultBankChargeAccount = patch.defaultBankChargeAccount;
    }
    if (patch.featureFlags !== undefined) {
      // Merge so callers can flip one flag without echoing the rest.
      next.featureFlags = { ...current.featureFlags, ...patch.featureFlags };
    }

    await this.db
      .update(organizations)
      .set(next as any)
      .where(eq(organizations.id, current.id));

    return this.refresh();
  }
}

function mapRow(row: typeof organizations.$inferSelect): OrgSnapshot {
  const mode = (row.countryMode ?? 'TH') as CountryMode;
  return {
    id: row.id,
    countryMode: mode,
    vatRegistered: row.vatRegistered,
    currency: row.currency,
    locale: row.locale,
    timezone: row.timezone,
    sellerName: row.sellerName ?? '',
    sellerTin: row.sellerTin,
    sellerBranch: row.sellerBranch ?? '00000',
    sellerAddress: row.sellerAddress ?? '',
    vatRate: Number(row.vatRate),
    defaultVatMode: (row.defaultVatMode ?? 'exclusive') as 'inclusive' | 'exclusive',
    abbreviatedTaxInvoiceCapCents: row.abbreviatedTaxInvoiceCapCents,
    promptpayBillerId: row.promptpayBillerId,
    promptpayRefundId: row.promptpayRefundId,
    fxSource: row.fxSource,
    defaultBankChargeAccount: row.defaultBankChargeAccount ?? '6170',
    featureFlags: { ...DEFAULT_FEATURE_FLAGS, ...normaliseFeatureFlags(row.featureFlags) },
  };
}
