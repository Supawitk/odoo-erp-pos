import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { branches, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { OrganizationService } from './organization.service';

export interface BranchRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  isHeadOffice: boolean;
}

export interface CreateBranchInput {
  code: string;
  name: string;
  address?: string;
  phone?: string;
}

@Injectable()
export class BranchesService {
  private readonly logger = new Logger(BranchesService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly org: OrganizationService,
  ) {}

  async list(opts: { activeOnly?: boolean } = {}): Promise<BranchRow[]> {
    const orgSnap = await this.org.snapshot();
    const conds = [eq(branches.organizationId, orgSnap.id)];
    if (opts.activeOnly !== false) conds.push(eq(branches.isActive, true));
    const rows = await this.db
      .select()
      .from(branches)
      .where(and(...conds))
      .orderBy(asc(branches.code));
    return rows;
  }

  async findById(id: string): Promise<BranchRow | null> {
    const [row] = await this.db
      .select()
      .from(branches)
      .where(eq(branches.id, id))
      .limit(1);
    return row ?? null;
  }

  async findByCode(code: string): Promise<BranchRow | null> {
    const orgSnap = await this.org.snapshot();
    const [row] = await this.db
      .select()
      .from(branches)
      .where(and(eq(branches.organizationId, orgSnap.id), eq(branches.code, code)))
      .limit(1);
    return row ?? null;
  }

  async create(input: CreateBranchInput): Promise<BranchRow> {
    if (!/^\d{5}$/.test(input.code)) {
      throw new Error('branch code must be exactly 5 digits');
    }
    if (!input.name?.trim()) throw new Error('branch name is required');
    const orgSnap = await this.org.snapshot();

    const existing = await this.findByCode(input.code);
    if (existing) {
      throw new Error(`branch code ${input.code} already exists`);
    }

    const [row] = await this.db
      .insert(branches)
      .values({
        organizationId: orgSnap.id,
        code: input.code,
        name: input.name.trim(),
        address: input.address?.trim() || null,
        phone: input.phone?.trim() || null,
        isHeadOffice: false,
        isActive: true,
      })
      .returning();
    this.logger.log(`Created branch ${row.code} ${row.name}`);
    return row;
  }

  async update(id: string, patch: Partial<CreateBranchInput> & { isActive?: boolean }): Promise<BranchRow> {
    const existing = await this.findById(id);
    if (!existing) throw new NotFoundException(`branch ${id} not found`);
    if (patch.code && patch.code !== existing.code) {
      if (!/^\d{5}$/.test(patch.code)) {
        throw new Error('branch code must be exactly 5 digits');
      }
      const conflict = await this.findByCode(patch.code);
      if (conflict && conflict.id !== id) {
        throw new Error(`branch code ${patch.code} already exists`);
      }
    }
    const [row] = await this.db
      .update(branches)
      .set({
        code: patch.code ?? existing.code,
        name: patch.name?.trim() ?? existing.name,
        address: patch.address === undefined ? existing.address : patch.address?.trim() || null,
        phone: patch.phone === undefined ? existing.phone : patch.phone?.trim() || null,
        isActive: patch.isActive ?? existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(branches.id, id))
      .returning();
    return row;
  }
}
