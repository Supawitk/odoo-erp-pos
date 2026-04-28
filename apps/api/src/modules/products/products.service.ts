import { Inject, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { products, type Database } from '@erp/db';
import { DRIZZLE } from '../../shared/infrastructure/database/database.module';
import { MeiliService } from './meili.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly meili: MeiliService,
  ) {}

  async list(opts: { limit?: number; offset?: number; category?: string }) {
    const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = opts.offset ?? 0;

    const where = opts.category
      ? and(eq(products.isActive, true), eq(products.category, opts.category))
      : eq(products.isActive, true);

    const rows = await this.db
      .select()
      .from(products)
      .where(where)
      .orderBy(products.name)
      .limit(limit)
      .offset(offset);
    return rows.map(this.mapRow);
  }

  /**
   * Hybrid search:
   *   - Meilisearch if available (multi-field, typo-tolerant, fast)
   *   - pg_trgm strict_word_similarity fallback (single-field, prefix-aware)
   * Both paths return the same shape.
   */
  async search(q: string, limit = 20) {
    const trimmed = q.trim();
    if (!trimmed) return [];
    const safeLimit = Math.min(limit, MAX_LIMIT);

    if (this.meili.isAvailable()) {
      try {
        const hits = await this.meili.search(trimmed, { limit: safeLimit });
        if (hits.length > 0) {
          // Hydrate full row from DB (stock + image + currency) by ID.
          const ids = hits.map((h) => h.id);
          const rows = await this.db
            .select()
            .from(products)
            .where(and(eq(products.isActive, true), inArray(products.id, ids)));
          const byId = new Map(rows.map((r) => [r.id, r]));
          return hits
            .map((h) => byId.get(h.id))
            .filter((r): r is NonNullable<typeof r> => !!r)
            .map((r) => ({ ...this.mapRow(r), source: 'meili' as const }));
        }
      } catch (err: any) {
        this.logger.warn(`Meilisearch search failed, falling back to pg_trgm: ${err?.message ?? err}`);
      }
    }

    const rows = await this.db
      .select({
        row: products,
        sim: sql<number>`strict_word_similarity(${products.name}, ${trimmed})`.as('sim'),
      })
      .from(products)
      .where(
        and(
          eq(products.isActive, true),
          sql`strict_word_similarity(${products.name}, ${trimmed}) > 0.3`,
        ),
      )
      .orderBy(desc(sql`strict_word_similarity(${products.name}, ${trimmed})`))
      .limit(safeLimit);

    return rows.map((r) => ({
      ...this.mapRow(r.row),
      similarity: Number(r.sim),
      source: 'pg_trgm' as const,
    }));
  }

  /**
   * Admin helper — push every active product into Meilisearch. Called at boot
   * and after any product catalog change. For Phase 2 this is a full reindex;
   * Phase 3 gets incremental via Odoo sync events.
   */
  async reindexMeili(): Promise<{ indexed: number; skipped: boolean }> {
    if (!this.meili.isAvailable()) return { indexed: 0, skipped: true };
    const rows = await this.db.select().from(products).where(eq(products.isActive, true));
    await this.meili.upsert(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        sku: r.sku,
        barcode: r.barcode,
        category: r.category,
        priceCents: r.priceCents,
        isActive: r.isActive,
      })),
    );
    return { indexed: rows.length, skipped: false };
  }

  /**
   * Barcode lookup with iOS EAN-13/UPC-A normalization:
   * VisionKit on iPad reports UPC-A (12 digits) as EAN-13 with a leading zero.
   * If scanned code is 13 digits starting with '0', try the 12-digit form too.
   */
  async findByBarcode(code: string) {
    const candidates = [code];
    if (/^0\d{12}$/.test(code)) candidates.push(code.slice(1));
    else if (/^\d{12}$/.test(code)) candidates.push('0' + code);

    const rows = await this.db
      .select()
      .from(products)
      .where(and(eq(products.isActive, true), inArray(products.barcode, candidates)))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException(`No product with barcode ${code}`);
    }
    return this.mapRow(rows[0]);
  }

  // ─── Single-product CRUD ──────────────────────────────────────────────
  async findById(id: string) {
    const [row] = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Product ${id} not found`);
    return this.mapRow(row);
  }

  async create(input: {
    name: string;
    sku?: string | null;
    barcode?: string | null;
    priceCents: number;
    currency?: string;
    category?: string | null;
    vatCategory?: 'standard' | 'zero' | 'exempt';
    reorderPoint?: number | null;
    reorderQty?: number | null;
    unitOfMeasure?: string;
    imageUrl?: string | null;
    isActive?: boolean;
  }) {
    if (!input.name?.trim()) throw new Error('name required');
    if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
      throw new Error('priceCents must be a non-negative integer (satang)');
    }
    const [row] = await this.db
      .insert(products)
      .values({
        name: input.name.trim(),
        sku: input.sku?.trim() || null,
        barcode: input.barcode?.replace(/\D/g, '') || null,
        priceCents: input.priceCents,
        currency: input.currency ?? 'THB',
        category: input.category?.trim() || null,
        vatCategory: input.vatCategory ?? 'standard',
        reorderPoint:
          input.reorderPoint == null ? null : String(input.reorderPoint),
        reorderQty: input.reorderQty == null ? null : String(input.reorderQty),
        unitOfMeasure: input.unitOfMeasure ?? 'piece',
        imageUrl: input.imageUrl?.trim() || null,
        isActive: input.isActive ?? true,
      })
      .returning();
    await this.meili.upsert([row]).catch(() => {});
    return this.mapRow(row);
  }

  async update(id: string, patch: Partial<Parameters<ProductsService['create']>[0]>) {
    const existing = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    if (existing.length === 0) throw new NotFoundException(`Product ${id} not found`);
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.sku !== undefined) set.sku = patch.sku?.trim() || null;
    if (patch.barcode !== undefined) set.barcode = patch.barcode?.replace(/\D/g, '') || null;
    if (patch.priceCents !== undefined) set.priceCents = patch.priceCents;
    if (patch.currency !== undefined) set.currency = patch.currency;
    if (patch.category !== undefined) set.category = patch.category?.trim() || null;
    if (patch.vatCategory !== undefined) set.vatCategory = patch.vatCategory;
    if (patch.reorderPoint !== undefined)
      set.reorderPoint = patch.reorderPoint == null ? null : String(patch.reorderPoint);
    if (patch.reorderQty !== undefined)
      set.reorderQty = patch.reorderQty == null ? null : String(patch.reorderQty);
    if (patch.unitOfMeasure !== undefined) set.unitOfMeasure = patch.unitOfMeasure;
    if (patch.imageUrl !== undefined) set.imageUrl = patch.imageUrl?.trim() || null;
    if (patch.isActive !== undefined) set.isActive = patch.isActive;
    const [row] = await this.db
      .update(products)
      .set(set as any)
      .where(eq(products.id, id))
      .returning();
    await this.meili.upsert([row]).catch(() => {});
    return this.mapRow(row);
  }

  async deactivate(id: string) {
    await this.db
      .update(products)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(products.id, id));
    return { ok: true };
  }

  private mapRow(r: typeof products.$inferSelect) {
    return {
      id: r.id,
      name: r.name,
      barcode: r.barcode,
      sku: r.sku,
      category: r.category,
      priceCents: r.priceCents,
      currency: r.currency,
      stockQty: Number(r.stockQty),
      imageUrl: r.imageUrl,
      vatCategory: r.vatCategory,
      unitOfMeasure: r.unitOfMeasure,
      reorderPoint: r.reorderPoint == null ? null : Number(r.reorderPoint),
      reorderQty: r.reorderQty == null ? null : Number(r.reorderQty),
      isActive: r.isActive,
    };
  }

  // ─── CSV import (Phase 3 gate) ──────────────────────────────────────
  /**
   * Bulk upsert from a parsed CSV. Columns expected (case-sensitive):
   *   name (required) | sku | barcode | priceCents (required, integer satang)
   *   currency (default THB) | category | vatCategory (standard|zero|exempt)
   *   reorderPoint | reorderQty | leadTimeDays | unitOfMeasure
   *
   * Upsert key: SKU when present, else name. Validation rules:
   *   - name non-empty
   *   - priceCents non-negative integer
   *   - barcode digits only if supplied
   *   - vatCategory in the closed set
   * On error a row is skipped + the row index + reason are returned.
   */
  async importRows(rows: Record<string, string>[]): Promise<{
    inserted: number;
    updated: number;
    errors: Array<{ row: number; reason: string }>;
  }> {
    let inserted = 0;
    let updated = 0;
    const errors: Array<{ row: number; reason: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = (r.name ?? '').trim();
      if (!name) {
        errors.push({ row: i + 2, reason: 'name is required' });
        continue;
      }
      const priceCents = Number((r.priceCents ?? r.priceCents ?? '').trim());
      if (!Number.isInteger(priceCents) || priceCents < 0) {
        errors.push({ row: i + 2, reason: 'priceCents must be a non-negative integer (satang)' });
        continue;
      }
      const barcode = (r.barcode ?? '').trim() || null;
      if (barcode && !/^\d{6,18}$/.test(barcode)) {
        errors.push({ row: i + 2, reason: `barcode must be 6-18 digits (got "${barcode}")` });
        continue;
      }
      const vatCategory = (r.vatCategory ?? 'standard').trim();
      if (!['standard', 'zero', 'exempt'].includes(vatCategory)) {
        errors.push({ row: i + 2, reason: `vatCategory must be standard|zero|exempt (got "${vatCategory}")` });
        continue;
      }

      const sku = (r.sku ?? '').trim() || null;
      const currency = (r.currency ?? 'THB').trim();
      const category = (r.category ?? '').trim() || null;
      const reorderPoint = (r.reorderPoint ?? '').trim();
      const reorderQty = (r.reorderQty ?? '').trim();
      const leadTimeDays = (r.leadTimeDays ?? '').trim();
      const unitOfMeasure = (r.unitOfMeasure ?? 'piece').trim();
      const imageUrl = (r.imageUrl ?? '').trim() || null;

      // Upsert by SKU if present, else by name+isActive.
      const existing = sku
        ? await this.db.select({ id: products.id }).from(products).where(eq(products.sku, sku)).limit(1)
        : await this.db.select({ id: products.id }).from(products).where(eq(products.name, name)).limit(1);

      const values = {
        name,
        sku,
        barcode,
        priceCents,
        currency,
        category,
        vatCategory,
        unitOfMeasure,
        reorderPoint: reorderPoint ? reorderPoint : null,
        reorderQty: reorderQty ? reorderQty : null,
        leadTimeDays: leadTimeDays ? Number(leadTimeDays) : null,
        imageUrl,
        updatedAt: new Date(),
      } as any;

      try {
        if (existing[0]) {
          await this.db.update(products).set(values).where(eq(products.id, existing[0].id));
          updated += 1;
        } else {
          await this.db.insert(products).values({ ...values, isActive: true });
          inserted += 1;
        }
      } catch (err: any) {
        errors.push({ row: i + 2, reason: err?.message ?? String(err) });
      }
    }

    if (inserted + updated > 0) {
      this.logger.log(`CSV import: ${inserted} inserted, ${updated} updated, ${errors.length} errors`);
      // Refresh Meili index so search picks up new rows.
      await this.reindexMeili().catch((err) => this.logger.warn(`Meili reindex skipped: ${err.message}`));
    }
    return { inserted, updated, errors };
  }
}
