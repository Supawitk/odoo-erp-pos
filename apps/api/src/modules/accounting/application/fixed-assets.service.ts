import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  chartOfAccounts,
  depreciationEntries,
  fixedAssets,
  journalEntries,
  journalEntryLines,
  type Database,
} from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import { JournalEntry } from '../domain/journal-entry';
import { JournalRepository } from '../infrastructure/journal.repository';
import {
  depreciationFor,
  depreciationSchedule,
  disposalJournalLines,
} from '../domain/depreciation';

export interface CreateFixedAssetInput {
  name: string;
  category?: string;
  acquisitionDate: string;
  acquisitionCostCents: number;
  salvageValueCents?: number;
  usefulLifeMonths: number;
  /** Asset GL account code — defaults to 1530 (equipment) if not provided. */
  assetAccountCode?: string;
  accumulatedDepreciationAccount?: string;
  expenseAccountCode?: string;
  /** Optional override for first depreciation month; defaults to month-after-acquisition. */
  depreciationStartDate?: string;
  createdBy?: string;
}

export interface DisposeFixedAssetInput {
  disposedAt: string;
  /** Sale proceeds in cents (0 for retirement / scrap). */
  disposalProceedsCents: number;
  /** Cash account that received the proceeds (ignored when proceeds=0). */
  cashAccountCode?: string;
}

@Injectable()
export class FixedAssetsService {
  private readonly logger = new Logger(FixedAssetsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly journals: JournalRepository,
  ) {}

  // ─── CRUD ────────────────────────────────────────────────────────────────

  async create(input: CreateFixedAssetInput) {
    if (!input.name?.trim()) throw new BadRequestException('name required');
    if (!Number.isInteger(input.acquisitionCostCents) || input.acquisitionCostCents <= 0) {
      throw new BadRequestException('acquisitionCostCents must be a positive integer');
    }
    const salvage = input.salvageValueCents ?? 0;
    if (!Number.isInteger(salvage) || salvage < 0 || salvage >= input.acquisitionCostCents) {
      throw new BadRequestException('salvageValueCents must be 0..cost-1');
    }
    if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths < 0) {
      throw new BadRequestException('usefulLifeMonths must be >= 0 (0 = non-depreciable)');
    }

    const assetAccount = input.assetAccountCode ?? '1530';
    // Validate the asset account exists + is an asset.
    const accts = await this.db
      .select({ code: chartOfAccounts.code, type: chartOfAccounts.type })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.code, assetAccount))
      .limit(1);
    if (accts.length === 0) throw new BadRequestException(`unknown asset account ${assetAccount}`);
    if (accts[0].type !== 'asset') {
      throw new BadRequestException(
        `assetAccountCode ${assetAccount} is type=${accts[0].type}, must be 'asset'`,
      );
    }

    // Default start: first day of the month following acquisition.
    const acqDate = new Date(input.acquisitionDate);
    const defaultStart = new Date(
      Date.UTC(acqDate.getUTCFullYear(), acqDate.getUTCMonth() + 1, 1),
    );
    const startDate =
      input.depreciationStartDate ?? defaultStart.toISOString().slice(0, 10);

    const assetNo = await this.allocateAssetNo();

    const [row] = await this.db
      .insert(fixedAssets)
      .values({
        id: uuidv7(),
        assetNo,
        name: input.name.trim(),
        category: input.category ?? 'equipment',
        acquisitionDate: input.acquisitionDate,
        acquisitionCostCents: input.acquisitionCostCents,
        salvageValueCents: salvage,
        usefulLifeMonths: input.usefulLifeMonths,
        assetAccountCode: assetAccount,
        accumulatedDepreciationAccount: input.accumulatedDepreciationAccount ?? '1590',
        expenseAccountCode: input.expenseAccountCode ?? '6190',
        depreciationStartDate: startDate,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return this.hydrate(row);
  }

  async list(opts: { status?: 'active' | 'disposed' | 'retired'; limit?: number } = {}) {
    const where = opts.status ? eq(fixedAssets.status, opts.status) : undefined;
    const rows = await this.db
      .select()
      .from(fixedAssets)
      .where(where as any)
      .orderBy(asc(fixedAssets.assetNo))
      .limit(opts.limit ?? 500);
    // Augment with accumulated depreciation in one round-trip.
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    const accRows = await this.db
      .select({
        fixedAssetId: depreciationEntries.fixedAssetId,
        accumulatedCents: sql<number>`coalesce(sum(${depreciationEntries.amountCents}), 0)::bigint`,
      })
      .from(depreciationEntries)
      .where(sql`${depreciationEntries.fixedAssetId} IN ${ids}`)
      .groupBy(depreciationEntries.fixedAssetId);
    const accMap = new Map(accRows.map((r) => [r.fixedAssetId, Number(r.accumulatedCents)]));
    return rows.map((r) => this.hydrate(r, accMap.get(r.id) ?? 0));
  }

  async findOne(id: string) {
    const rows = await this.db
      .select()
      .from(fixedAssets)
      .where(eq(fixedAssets.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`fixed asset ${id} not found`);
    const accRows = await this.db
      .select({
        accumulatedCents: sql<number>`coalesce(sum(${depreciationEntries.amountCents}), 0)::bigint`,
      })
      .from(depreciationEntries)
      .where(eq(depreciationEntries.fixedAssetId, id));
    const acc = Number(accRows[0]?.accumulatedCents ?? 0);
    return this.hydrate(rows[0], acc);
  }

  async schedule(id: string) {
    const row = await this.findOne(id);
    return depreciationSchedule({
      acquisitionCostCents: row.acquisitionCostCents,
      salvageValueCents: row.salvageValueCents,
      usefulLifeMonths: row.usefulLifeMonths,
      depreciationStartDate: row.depreciationStartDate,
    });
  }

  // ─── Monthly depreciation runner ─────────────────────────────────────────

  /**
   * Posts depreciation JEs for every active asset for the given period.
   * Idempotent — assets with an existing entry for that period are skipped.
   * Returns counts so the caller (cron or admin button) can surface them.
   */
  async runMonthlyDepreciation(year: number, month: number, opts: { postedBy?: string } = {}) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const lastDay = new Date(Date.UTC(year, month, 0));
    const periodEndDate = lastDay.toISOString().slice(0, 10);

    const assets = await this.db
      .select()
      .from(fixedAssets)
      .where(eq(fixedAssets.status, 'active'));

    // Pre-compute accumulated for everyone in the batch (one query, not N).
    const ids = assets.map((a) => a.id);
    const accMap = new Map<string, number>();
    if (ids.length > 0) {
      const accRows = await this.db
        .select({
          fixedAssetId: depreciationEntries.fixedAssetId,
          accumulatedCents: sql<number>`coalesce(sum(${depreciationEntries.amountCents}), 0)::bigint`,
        })
        .from(depreciationEntries)
        .where(sql`${depreciationEntries.fixedAssetId} IN ${ids}`)
        .groupBy(depreciationEntries.fixedAssetId);
      accRows.forEach((r) => accMap.set(r.fixedAssetId, Number(r.accumulatedCents)));
    }

    let posted = 0;
    let skipped = 0;
    const errors: Array<{ assetId: string; reason: string }> = [];

    for (const asset of assets) {
      // Idempotency check — does this period already have an entry?
      const existing = await this.db
        .select({ id: depreciationEntries.id })
        .from(depreciationEntries)
        .where(
          and(
            eq(depreciationEntries.fixedAssetId, asset.id),
            eq(depreciationEntries.period, period),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const calc = depreciationFor({
        acquisitionCostCents: Number(asset.acquisitionCostCents),
        salvageValueCents: Number(asset.salvageValueCents),
        usefulLifeMonths: asset.usefulLifeMonths,
        depreciationStartDate: asset.depreciationStartDate,
        accumulatedSoFarCents: accMap.get(asset.id) ?? 0,
        period,
      });

      if (calc.amountCents <= 0) {
        skipped++;
        continue;
      }

      try {
        const entry = JournalEntry.create({
          date: periodEndDate,
          description: `Depreciation ${period} — ${asset.assetNo} ${asset.name}`,
          reference: asset.assetNo,
          sourceModule: 'depreciation',
          sourceId: asset.id,
          currency: 'THB',
          lines: [
            {
              accountCode: asset.expenseAccountCode,
              accountName: 'Depreciation',
              debitCents: calc.amountCents,
              creditCents: 0,
            },
            {
              accountCode: asset.accumulatedDepreciationAccount,
              accountName: 'Accumulated depreciation',
              debitCents: 0,
              creditCents: calc.amountCents,
            },
          ],
        });
        const je = await this.journals.insert(entry, {
          autoPost: true,
          postedBy: opts.postedBy ?? null,
        });
        await this.db.insert(depreciationEntries).values({
          fixedAssetId: asset.id,
          period,
          amountCents: calc.amountCents,
          journalEntryId: je.id,
        });
        posted++;
      } catch (e: any) {
        errors.push({ assetId: asset.id, reason: e?.message ?? String(e) });
      }
    }

    return { period, posted, skipped, errors, assetCount: assets.length };
  }

  // ─── Disposal ────────────────────────────────────────────────────────────

  async dispose(id: string, input: DisposeFixedAssetInput) {
    if (!Number.isInteger(input.disposalProceedsCents) || input.disposalProceedsCents < 0) {
      throw new BadRequestException('disposalProceedsCents must be >= 0');
    }
    const asset = await this.findOne(id);
    if (asset.status !== 'active') {
      throw new BadRequestException(`asset is ${asset.status}; only active assets can be disposed`);
    }

    const lines = disposalJournalLines({
      acquisitionCostCents: asset.acquisitionCostCents,
      accumulatedDepreciationCents: asset.accumulatedDepreciationCents,
      disposalProceedsCents: input.disposalProceedsCents,
      cashAccountCode: input.cashAccountCode ?? '1120',
      assetAccountCode: asset.assetAccountCode,
      accumulatedDepreciationAccount: asset.accumulatedDepreciationAccount,
    });
    const entry = JournalEntry.create({
      date: input.disposedAt,
      description: `Disposal of ${asset.assetNo} ${asset.name}`,
      reference: asset.assetNo,
      sourceModule: 'fixed_assets_disposal',
      sourceId: id,
      currency: 'THB',
      lines: lines.map((l) => ({
        accountCode: l.accountCode,
        accountName: '',
        debitCents: l.debitCents,
        creditCents: l.creditCents,
      })),
    });
    const je = await this.journals.insert(entry, { autoPost: true });
    const status = input.disposalProceedsCents > 0 ? 'disposed' : 'retired';
    await this.db
      .update(fixedAssets)
      .set({
        status,
        disposedAt: input.disposedAt,
        disposalProceedsCents: input.disposalProceedsCents,
        disposalJournalEntryId: je.id,
        updatedAt: new Date(),
      })
      .where(eq(fixedAssets.id, id));
    return this.findOne(id);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private async allocateAssetNo(): Promise<string> {
    // FA-YYYY-NNNN — independent yearly sequence so the user can read the
    // year off the number at a glance.
    const year = new Date().getUTCFullYear();
    const prefix = `FA-${year}-`;
    const last = await this.db
      .select({ assetNo: fixedAssets.assetNo })
      .from(fixedAssets)
      .where(sql`${fixedAssets.assetNo} LIKE ${prefix + '%'}`)
      .orderBy(desc(fixedAssets.assetNo))
      .limit(1);
    const lastNo = last[0]?.assetNo;
    const next = lastNo ? Number(lastNo.split('-').pop()) + 1 : 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  private hydrate(row: typeof fixedAssets.$inferSelect, accumulated = 0) {
    const cost = Number(row.acquisitionCostCents);
    const salvage = Number(row.salvageValueCents);
    const depreciableBase = cost - salvage;
    const netBookValue = cost - accumulated;
    return {
      id: row.id,
      assetNo: row.assetNo,
      name: row.name,
      category: row.category,
      acquisitionDate: row.acquisitionDate,
      acquisitionCostCents: cost,
      salvageValueCents: salvage,
      depreciableBaseCents: depreciableBase,
      usefulLifeMonths: row.usefulLifeMonths,
      depreciationMethod: row.depreciationMethod,
      assetAccountCode: row.assetAccountCode,
      accumulatedDepreciationAccount: row.accumulatedDepreciationAccount,
      expenseAccountCode: row.expenseAccountCode,
      depreciationStartDate: row.depreciationStartDate,
      status: row.status as 'active' | 'disposed' | 'retired',
      disposedAt: row.disposedAt,
      disposalProceedsCents: row.disposalProceedsCents
        ? Number(row.disposalProceedsCents)
        : null,
      disposalJournalEntryId: row.disposalJournalEntryId,
      accumulatedDepreciationCents: accumulated,
      netBookValueCents: netBookValue,
      isFullyDepreciated:
        accumulated >= depreciableBase && depreciableBase > 0,
      createdAt: row.createdAt,
    };
  }
}
