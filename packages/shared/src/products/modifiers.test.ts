import { describe, it, expect } from 'vitest';
import {
  isValidModifierGroups,
  validateChosenModifiers,
  sumModifierDeltas,
  type ModifierGroup,
  type OrderLineModifier,
} from './modifiers';

const sizeGroup: ModifierGroup = {
  id: 'size',
  name: 'Size',
  required: true,
  multi: false,
  options: [
    { id: 's', name: 'Small', priceDeltaCents: 0 },
    { id: 'm', name: 'Medium', priceDeltaCents: 2000 },
    { id: 'l', name: 'Large', priceDeltaCents: 4000 },
  ],
};

const toppingsGroup: ModifierGroup = {
  id: 'top',
  name: 'Toppings',
  required: false,
  multi: true,
  options: [
    { id: 'cheese', name: 'Cheese', priceDeltaCents: 1500 },
    { id: 'bacon', name: 'Bacon', priceDeltaCents: 2500 },
  ],
};

describe('isValidModifierGroups', () => {
  it('accepts a well-formed groups array', () => {
    expect(isValidModifierGroups([sizeGroup, toppingsGroup])).toBe(true);
  });
  it('accepts an empty array', () => {
    expect(isValidModifierGroups([])).toBe(true);
  });
  it('rejects non-array input', () => {
    expect(isValidModifierGroups('foo')).toBe(false);
    expect(isValidModifierGroups(null)).toBe(false);
    expect(isValidModifierGroups({})).toBe(false);
  });
  it('rejects non-integer priceDeltaCents', () => {
    expect(
      isValidModifierGroups([
        {
          ...sizeGroup,
          options: [{ id: 'a', name: 'A', priceDeltaCents: 12.5 } as any],
        },
      ]),
    ).toBe(false);
  });
  it('rejects missing required fields', () => {
    expect(isValidModifierGroups([{ id: 'g', name: 'G' } as any])).toBe(false);
  });
});

describe('validateChosenModifiers', () => {
  it('accepts a valid single-select pick from a required group', () => {
    const chosen: OrderLineModifier[] = [
      { groupName: 'Size', name: 'Medium', priceDeltaCents: 2000 },
    ];
    expect(validateChosenModifiers([sizeGroup, toppingsGroup], chosen)).toEqual(chosen);
  });

  it('accepts multiple picks from a multi-select group', () => {
    const chosen: OrderLineModifier[] = [
      { groupName: 'Size', name: 'Medium', priceDeltaCents: 2000 },
      { groupName: 'Toppings', name: 'Cheese', priceDeltaCents: 1500 },
      { groupName: 'Toppings', name: 'Bacon', priceDeltaCents: 2500 },
    ];
    expect(validateChosenModifiers([sizeGroup, toppingsGroup], chosen)).toEqual(chosen);
  });

  it('rejects when a required group has no pick', () => {
    const chosen: OrderLineModifier[] = [
      { groupName: 'Toppings', name: 'Cheese', priceDeltaCents: 1500 },
    ];
    expect(() =>
      validateChosenModifiers([sizeGroup, toppingsGroup], chosen),
    ).toThrow(/Required modifier group "Size"/);
  });

  it('rejects empty chosen when any group is required', () => {
    expect(() => validateChosenModifiers([sizeGroup], [])).toThrow(/Required/);
  });

  it('accepts empty chosen when no groups are required', () => {
    expect(validateChosenModifiers([toppingsGroup], [])).toEqual([]);
  });

  it('rejects multiple picks in a single-select group', () => {
    const chosen: OrderLineModifier[] = [
      { groupName: 'Size', name: 'Small', priceDeltaCents: 0 },
      { groupName: 'Size', name: 'Large', priceDeltaCents: 4000 },
    ];
    expect(() =>
      validateChosenModifiers([sizeGroup, toppingsGroup], chosen),
    ).toThrow(/single-select but received 2 picks/);
  });

  it('rejects unknown group', () => {
    const chosen: OrderLineModifier[] = [
      { groupName: 'NotAGroup', name: 'Whatever', priceDeltaCents: 0 },
    ];
    expect(() =>
      validateChosenModifiers([sizeGroup], chosen),
    ).toThrow(/not on product/);
  });

  it('rejects tampered price delta (right name, wrong delta)', () => {
    const chosen: OrderLineModifier[] = [
      { groupName: 'Size', name: 'Medium', priceDeltaCents: 1 }, // master says 2000
    ];
    expect(() =>
      validateChosenModifiers([sizeGroup], chosen),
    ).toThrow(/does not match/);
  });

  it('rejects tampered name (right delta, wrong name)', () => {
    const chosen: OrderLineModifier[] = [
      { groupName: 'Size', name: 'Extra Large', priceDeltaCents: 4000 },
    ];
    expect(() =>
      validateChosenModifiers([sizeGroup], chosen),
    ).toThrow(/does not match/);
  });
});

describe('sumModifierDeltas', () => {
  it('returns 0 for empty/null', () => {
    expect(sumModifierDeltas(null)).toBe(0);
    expect(sumModifierDeltas(undefined)).toBe(0);
    expect(sumModifierDeltas([])).toBe(0);
  });
  it('sums positive and negative deltas', () => {
    expect(
      sumModifierDeltas([
        { groupName: 'Size', name: 'Large', priceDeltaCents: 4000 },
        { groupName: 'Discount', name: 'Member', priceDeltaCents: -500 },
      ]),
    ).toBe(3500);
  });
});
