import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { isValidTIN, normalizeTIN } from '@erp/shared';
import { partners, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { EncryptionService } from '../../../shared/infrastructure/crypto/encryption.service';
import { InvalidSupplierTinError } from '../domain/errors';

export interface CreatePartnerInput {
  name: string;
  legalName?: string;
  isSupplier?: boolean;
  isCustomer?: boolean;
  isEmployee?: boolean;
  email?: string;
  phone?: string;
  tin?: string;
  branchCode?: string;
  vatRegistered?: boolean;
  address?: Record<string, unknown>;
  defaultCurrency?: string;
  paymentTermsDays?: number;
  whtCategory?: string;
  notes?: string;
}

@Injectable()
export class PartnersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: EncryptionService,
  ) {}

  async create(input: CreatePartnerInput) {
    const normalisedTin = input.tin ? normalizeTIN(input.tin) : null;
    if (normalisedTin && !isValidTIN(normalisedTin)) {
      throw new InvalidSupplierTinError(input.tin!);
    }

    const tinEnc = await this.crypto.encryptAndHash(normalisedTin);

    const [row] = await this.db
      .insert(partners)
      .values({
        name: input.name,
        legalName: input.legalName ?? null,
        isSupplier: input.isSupplier ?? false,
        isCustomer: input.isCustomer ?? false,
        isEmployee: input.isEmployee ?? false,
        email: input.email ?? null,
        phone: input.phone ?? null,
        tin: normalisedTin,
        tinEncrypted: tinEnc.encrypted,
        tinHash: tinEnc.hash,
        branchCode: input.branchCode ?? '00000',
        vatRegistered: input.vatRegistered ?? false,
        address: input.address ?? null,
        defaultCurrency: input.defaultCurrency ?? 'THB',
        paymentTermsDays: input.paymentTermsDays ?? 30,
        whtCategory: input.whtCategory ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    return row;
  }

  async list(opts?: {
    role?: 'supplier' | 'customer' | 'employee';
    search?: string;
    activeOnly?: boolean;
  }) {
    const conds = [];
    if (opts?.activeOnly !== false) conds.push(eq(partners.isActive, true));
    if (opts?.role === 'supplier') conds.push(eq(partners.isSupplier, true));
    if (opts?.role === 'customer') conds.push(eq(partners.isCustomer, true));
    if (opts?.role === 'employee') conds.push(eq(partners.isEmployee, true));
    if (opts?.search) {
      const q = `%${opts.search}%`;
      conds.push(
        or(
          ilike(partners.name, q),
          ilike(partners.legalName, q),
          ilike(partners.email, q),
          ilike(partners.tin, q),
        )!,
      );
    }
    return this.db
      .select()
      .from(partners)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(partners.name);
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(partners)
      .where(eq(partners.id, id))
      .limit(1);
    return row ?? null;
  }

  async update(id: string, patch: Partial<CreatePartnerInput>) {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === 'tin' && typeof v === 'string') {
        const normalised = normalizeTIN(v);
        if (!isValidTIN(normalised)) throw new InvalidSupplierTinError(v);
        set.tin = normalised;
        const enc = await this.crypto.encryptAndHash(normalised);
        set.tinEncrypted = enc.encrypted;
        set.tinHash = enc.hash;
        continue;
      }
      // camel→snake mapping is handled by Drizzle; just pass camel keys.
      set[k] = v;
    }
    set.updatedAt = new Date();
    const [row] = await this.db
      .update(partners)
      .set(set as any)
      .where(eq(partners.id, id))
      .returning();
    return row ?? null;
  }

  async deactivate(id: string) {
    await this.db
      .update(partners)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(partners.id, id));
  }
}
