import {
  dinero,
  add,
  subtract,
  allocate,
  toSnapshot,
  equal,
  greaterThan,
  lessThan,
  type Dinero,
} from "dinero.js";
import { USD, EUR, GBP, THB, JPY } from "@dinero.js/currencies";

export const CURRENCIES = { USD, EUR, GBP, THB, JPY } as const;
export type CurrencyCode = keyof typeof CURRENCIES;

/**
 * Money value object. Wraps dinero.js to enforce:
 * - Integer cents only (no float)
 * - Currency-match at compile time
 * - Rounding-safe operations via `allocate`
 */
export class Money {
  private readonly inner: Dinero<number>;

  private constructor(inner: Dinero<number>) {
    this.inner = inner;
  }

  static ofCents(amount: number, currency: CurrencyCode = "USD"): Money {
    if (!Number.isInteger(amount)) {
      throw new Error(`Money.ofCents requires integer amount, got ${amount}`);
    }
    return new Money(dinero({ amount, currency: CURRENCIES[currency] }));
  }

  static zero(currency: CurrencyCode = "USD"): Money {
    return Money.ofCents(0, currency);
  }

  static fromDecimal(value: number, currency: CurrencyCode = "USD"): Money {
    // 12.34 USD -> 1234 cents
    const { scale } = toSnapshot(dinero({ amount: 1, currency: CURRENCIES[currency] }));
    const multiplier = Math.pow(10, scale);
    return Money.ofCents(Math.round(value * multiplier), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(add(this.inner, other.inner));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(subtract(this.inner, other.inner));
  }

  multiply(factor: number): Money {
    if (!Number.isFinite(factor)) throw new Error("multiply factor must be finite");
    // Preserve scale by computing in cents directly — dinero.multiply with a
    // scaled factor increases the result scale, which breaks toCents().
    const cents = Math.round(this.toCents() * factor);
    return Money.ofCents(cents, this.currency());
  }

  /**
   * Split money into N parts by ratios. Remainder goes to largest share.
   * Essential for tax distribution, split payments, change calculation.
   */
  allocate(ratios: number[]): Money[] {
    return allocate(this.inner, ratios).map((d) => new Money(d));
  }

  equals(other: Money): boolean {
    return equal(this.inner, other.inner);
  }

  greaterThan(other: Money): boolean {
    return greaterThan(this.inner, other.inner);
  }

  lessThan(other: Money): boolean {
    return lessThan(this.inner, other.inner);
  }

  isZero(): boolean {
    return this.toCents() === 0;
  }

  isPositive(): boolean {
    return this.toCents() > 0;
  }

  isNegative(): boolean {
    return this.toCents() < 0;
  }

  toCents(): number {
    return toSnapshot(this.inner).amount;
  }

  toDecimal(): number {
    const snap = toSnapshot(this.inner);
    return snap.amount / Math.pow(10, snap.scale);
  }

  currency(): CurrencyCode {
    const code = toSnapshot(this.inner).currency.code;
    return code as CurrencyCode;
  }

  format(locale = "en-US"): string {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: this.currency(),
    }).format(this.toDecimal());
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency() !== other.currency()) {
      throw new Error(
        `Currency mismatch: ${this.currency()} vs ${other.currency()}`,
      );
    }
  }
}
