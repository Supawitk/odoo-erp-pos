/**
 * MIS Builder report types — wire format that mirrors what Odoo's
 * `mis.report.instance.compute()` returns, but computed against our own
 * custom.journal_entry_lines so accounting stays canonical in our schema.
 *
 * Templates (KPIs, expressions, styles, sequence) ARE pulled from Odoo —
 * we use OCA's TFRS-format Thai BS/PL/TB definitions as the rendering
 * template. Values are evaluated by mis-expression.evaluator against our
 * own ledger.
 */

export interface MisCell {
  /** Numeric value in baht (decimal — already converted from cents). */
  value: number;
  /** Display string, locale-formatted (Thai/EN aware). */
  display: string;
  /** Optional inline CSS style from MIS template (font-weight, color). */
  style?: string;
  /** Optional account-type hint for visual grouping. */
  accountType?: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
}

export interface MisRow {
  /** KPI machine name (e.g. REVENUE, EXPENSE, PL). */
  name: string;
  /** Display label — Thai if available, falls back to English. */
  label: string;
  /** Optional sequence (lower = earlier in render). */
  sequence: number;
  /** Optional description shown as tooltip / aria-label. */
  description?: string;
  /** Inline CSS style string from MIS template. */
  style?: string;
  /**
   * True when this row is a section header (no value computed — `AccountingNone`
   * sentinel from the OCA template). UI should render label only, no money cell.
   */
  isHeader?: boolean;
  /** Cells, one per period. Empty array when isHeader=true. */
  cells: MisCell[];
}

export interface MisPeriod {
  /** Period machine name (current, previous, ytd). */
  name: string;
  /** Locale-aware label. */
  label: string;
  dateFrom: string; // ISO yyyy-mm-dd
  dateTo: string;
}

export interface MisReport {
  templateId: number;
  templateName: string;
  /** Inferred kind from template id — falls back to CUSTOM. */
  kind: 'BS' | 'PL' | 'TB' | 'CUSTOM';
  periods: MisPeriod[];
  rows: MisRow[];
  /** When this snapshot was computed. */
  computedAt: string;
  /** Currency. THB for Thai-mode orgs. */
  currency: string;
  /** Where the template definition came from. */
  templateSource: 'odoo' | 'fallback';
  /** Honest note when Odoo was unavailable and we used the fallback. */
  warning?: string;
}

/** Compact KPI shape pulled from Odoo and used by the evaluator. */
export interface MisKpi {
  id: number;
  name: string; // e.g. REVENUE
  label: string;
  sequence: number;
  type: string; // num | pct | str
  accumulationMethod: 'sum' | 'avg' | 'last' | string;
  styleExpression?: string;
  description?: string;
  /** Default expression (no sub-KPI breakdown). */
  expression?: string;
}

export interface MisTemplate {
  id: number;
  name: string;
  kind: 'BS' | 'PL' | 'TB' | 'CUSTOM';
  kpis: MisKpi[];
  /** True when the template was pulled from a live Odoo. */
  fromOdoo: boolean;
}

export interface MisListEntry {
  id: number;
  name: string;
  kind: 'BS' | 'PL' | 'TB' | 'CUSTOM';
  fromOdoo: boolean;
}
