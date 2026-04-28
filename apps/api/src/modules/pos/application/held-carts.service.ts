import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { heldCarts, type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';

export interface HeldCartLine {
  productId: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  vatCategory?: 'standard' | 'zero' | 'exempt';
  vatMode?: 'inclusive' | 'exclusive';
  discountCents?: number;
}

export interface HoldCartInput {
  sessionId: string;
  label: string;
  lines: HeldCartLine[];
  buyer?: {
    name?: string;
    tin?: string;
    branch?: string;
    address?: string;
  } | null;
  cartDiscountCents?: number;
}

@Injectable()
export class HeldCartsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async hold(input: HoldCartInput) {
    if (!input.label?.trim()) throw new Error('label required');
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new Error('lines required');
    }
    const [row] = await this.db
      .insert(heldCarts)
      .values({
        sessionId: input.sessionId,
        label: input.label.trim(),
        cartLines: input.lines as unknown,
        buyer: input.buyer as unknown,
        cartDiscountCents: input.cartDiscountCents ?? 0,
      })
      .returning();
    return row;
  }

  async list(sessionId?: string) {
    const where = sessionId ? eq(heldCarts.sessionId, sessionId) : undefined;
    return this.db
      .select()
      .from(heldCarts)
      .where(where)
      .orderBy(desc(heldCarts.createdAt))
      .limit(50);
  }

  async findById(id: string) {
    const [row] = await this.db
      .select()
      .from(heldCarts)
      .where(eq(heldCarts.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * Recall: returns the held cart and deletes the row in the same operation.
   * The caller (web POS / iPad POS) re-hydrates the cart and proceeds to
   * checkout. If checkout fails, the cart is gone — caller can re-hold it.
   */
  async recall(id: string, opts: { sessionId?: string } = {}) {
    const conds = [eq(heldCarts.id, id)];
    if (opts.sessionId) conds.push(eq(heldCarts.sessionId, opts.sessionId));
    const rows = await this.db
      .delete(heldCarts)
      .where(and(...conds))
      .returning();
    if (rows.length === 0) {
      throw new NotFoundException(`held cart ${id} not found`);
    }
    return rows[0];
  }

  async cancel(id: string) {
    const rows = await this.db
      .delete(heldCarts)
      .where(eq(heldCarts.id, id))
      .returning();
    if (rows.length === 0) {
      throw new NotFoundException(`held cart ${id} not found`);
    }
    return { ok: true };
  }
}
