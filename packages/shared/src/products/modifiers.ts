/**
 * Product modifier groups: configurable add-ons / variants per product.
 *
 * Examples:
 *   - "Size" group with options [Small +0, Medium +20฿, Large +40฿] (single-select, required)
 *   - "Toppings" group with options [Cheese +15฿, Bacon +25฿]        (multi-select, optional)
 *   - "Sugar level" group with options [0%, 50%, 100%] (single-select, required, all delta=0)
 *
 * Snapshot model: when a line is sold, we copy {name, priceDeltaCents} onto
 * the order line, NOT just the option id. That way historical orders never
 * lie even if the product master is later edited or the option deleted.
 */
export interface ModifierOption {
  /** Stable id (uuid or short slug) — referenced by POS UI but not required on order line. */
  id: string;
  /** Display name shown on POS, receipt, KOT. */
  name: string;
  /** Cents added to the line's per-unit price when this option is selected. May be 0 or negative. */
  priceDeltaCents: number;
}

export interface ModifierGroup {
  id: string;
  /** Group label ("Size", "Sugar level", "Toppings"). */
  name: string;
  /** When true: at least one option must be picked. UI blocks "add to cart" otherwise. */
  required: boolean;
  /** When true: customer may pick more than one option from this group. */
  multi: boolean;
  options: ModifierOption[];
}

/**
 * Snapshot of a chosen modifier persisted on an order line. Frozen at sale
 * time — independent of the product master afterwards.
 */
export interface OrderLineModifier {
  /** Group label (denormalised for receipts/KOT). */
  groupName: string;
  /** Option label. */
  name: string;
  /** Per-unit price delta. */
  priceDeltaCents: number;
}

/** Validate the structural shape of a modifier-groups payload. */
export function isValidModifierGroups(input: unknown): input is ModifierGroup[] {
  if (!Array.isArray(input)) return false;
  for (const g of input) {
    if (!g || typeof g !== 'object') return false;
    const grp = g as Record<string, unknown>;
    if (typeof grp.id !== 'string' || !grp.id) return false;
    if (typeof grp.name !== 'string' || !grp.name) return false;
    if (typeof grp.required !== 'boolean') return false;
    if (typeof grp.multi !== 'boolean') return false;
    if (!Array.isArray(grp.options)) return false;
    for (const o of grp.options) {
      if (!o || typeof o !== 'object') return false;
      const opt = o as Record<string, unknown>;
      if (typeof opt.id !== 'string' || !opt.id) return false;
      if (typeof opt.name !== 'string' || !opt.name) return false;
      if (typeof opt.priceDeltaCents !== 'number' || !Number.isInteger(opt.priceDeltaCents)) return false;
    }
  }
  return true;
}

/**
 * Validate a chosen modifier list against the product's groups. Returns the
 * snapshot the server will persist, or throws with a specific reason.
 *
 * Rules enforced:
 *   - Each chosen modifier must match an option (by name + delta) in some group.
 *   - Single-select groups can have at most one chosen option.
 *   - Required groups must have at least one chosen option.
 *
 * The "match by name + delta" comparison is intentionally tight — if the
 * client sends a delta that doesn't match the master, it's tampering and
 * we reject. (Matching by id alone would let a stale client send the right
 * id with a wrong delta.)
 */
export function validateChosenModifiers(
  groups: ModifierGroup[],
  chosen: OrderLineModifier[],
): OrderLineModifier[] {
  if (chosen.length === 0) {
    // Required groups still need a pick — fail fast.
    const missing = groups.filter((g) => g.required).map((g) => g.name);
    if (missing.length > 0) {
      throw new Error(`Required modifier groups not chosen: ${missing.join(', ')}`);
    }
    return [];
  }

  const byGroup = new Map<string, OrderLineModifier[]>();
  for (const m of chosen) {
    if (!m.groupName || !m.name) {
      throw new Error('Modifier missing groupName or name');
    }
    if (!Number.isInteger(m.priceDeltaCents)) {
      throw new Error(`Modifier "${m.name}" priceDeltaCents must be integer satang`);
    }
    const arr = byGroup.get(m.groupName) ?? [];
    arr.push(m);
    byGroup.set(m.groupName, arr);
  }

  const masterByName = new Map(groups.map((g) => [g.name, g]));
  for (const [groupName, picks] of byGroup) {
    const grp = masterByName.get(groupName);
    if (!grp) throw new Error(`Modifier group "${groupName}" not on product`);
    if (!grp.multi && picks.length > 1) {
      throw new Error(`Group "${groupName}" is single-select but received ${picks.length} picks`);
    }
    for (const pick of picks) {
      const match = grp.options.find(
        (o) => o.name === pick.name && o.priceDeltaCents === pick.priceDeltaCents,
      );
      if (!match) {
        throw new Error(
          `Modifier "${pick.name}" (Δ${pick.priceDeltaCents}) does not match any option in "${groupName}"`,
        );
      }
    }
  }

  for (const grp of groups) {
    if (grp.required && !byGroup.has(grp.name)) {
      throw new Error(`Required modifier group "${grp.name}" missing`);
    }
  }

  return chosen.map((m) => ({
    groupName: m.groupName,
    name: m.name,
    priceDeltaCents: m.priceDeltaCents,
  }));
}

/** Sum the per-unit price deltas of an order line's modifiers. */
export function sumModifierDeltas(modifiers: OrderLineModifier[] | undefined | null): number {
  if (!modifiers || modifiers.length === 0) return 0;
  return modifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0);
}
