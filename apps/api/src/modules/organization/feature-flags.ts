/**
 * Pro Mode feature flags. Default-off so a single-shop sole-proprietor never
 * has to think about branches, warehouses, lots, excise, AR-WHT, or
 * dual-currency print. When a merchant grows into one of these concerns they
 * flip a switch in /settings and the matching UI surfaces.
 *
 * Data model is unaffected: branches.code='00000' and a single warehouse
 * always exist; the flags only gate UI visibility and a few formatters.
 */
export type FeatureFlags = {
  /** Show branch picker on POS, branch column on dashboard, branch prefix in sequences. */
  multiBranch: boolean;
  /** Show warehouse picker in inventory ops + GRN destination select. */
  multiWarehouse: boolean;
  /** Surface lot/serial entry on GRN + FEFO tracker on stock cards. */
  lotSerialTracking: boolean;
  /**
   * Excise tax fields on product form + line-level excise breakdown on print.
   * Forward-compatible hook — currently a no-op until the product create/edit
   * form ships. When the form lands it'll read this flag to surface excise
   * inputs (alcohol / tobacco / sugar drinks).
   */
  exciseTax: boolean;
  /** AR-WHT (account 1157) booking flow when juristic-person customer pays net. */
  arWht: boolean;
  /**
   * Foreign-currency invoice with THB dual-currency print + BoT FX lock.
   * Forward-compatible hook — currently a no-op. The invoice form uses the
   * org default currency on every line. When per-invoice currency override
   * lands it'll read this flag to surface the currency picker + FX rate
   * (BoT mid-rate at tax-point date, §9.11).
   */
  dualCurrencyPrint: boolean;
  /**
   * Restaurant / F&B mode. Surfaces order type (dine-in / takeout / delivery),
   * table number, tip handling, and split-bill flow on the POS screen. Off by
   * default so retail shops don't see fields they don't need.
   */
  restaurantMode: boolean;
};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  multiBranch: false,
  multiWarehouse: false,
  lotSerialTracking: false,
  exciseTax: false,
  arWht: false,
  dualCurrencyPrint: false,
  restaurantMode: false,
};

export function normaliseFeatureFlags(raw: unknown): FeatureFlags {
  const partial = (raw && typeof raw === 'object' ? raw : {}) as Partial<FeatureFlags>;
  return {
    multiBranch: !!partial.multiBranch,
    multiWarehouse: !!partial.multiWarehouse,
    lotSerialTracking: !!partial.lotSerialTracking,
    exciseTax: !!partial.exciseTax,
    arWht: !!partial.arWht,
    dualCurrencyPrint: !!partial.dualCurrencyPrint,
    restaurantMode: !!partial.restaurantMode,
  };
}
