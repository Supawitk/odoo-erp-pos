// Shared accounting type definitions used across the tabs.
// Extracted from the previously monolithic accounting.tsx during the
// 2026-05-04 refactor; same shapes, no logic changed.

export type ChartAccount = {
  code: string;
  name: string;
  nameTh: string | null;
  nameEn: string | null;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parentCode: string | null;
  isActive: boolean;
  normalBalance: "debit" | "credit";
  isCashAccount?: boolean;
};

export type JournalEntryRow = {
  id: string;
  entryNumber: number;
  date: string;
  description: string;
  reference: string | null;
  sourceModule: string | null;
  sourceId: string | null;
  currency: string;
  totalDebitCents: number;
  totalCreditCents: number;
  status: "draft" | "posted" | "voided";
};

export type TrialBalanceRow = {
  accountCode: string;
  accountName: string;
  type: ChartAccount["type"];
  normalBalance: "debit" | "credit";
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};

export type Tab =
  | "trial-balance"
  | "balance-sheet"
  | "profit-loss"
  | "cash-flow"
  | "bank-rec"
  | "fixed-assets"
  | "journal"
  | "chart"
  | "tax-filings"
  | "tfrs"
  | "period-close"
  | "cash-book";

// ─── Period Close (OCA account-closing) ────────────────────────────────────

export type PeriodCloseSummary = {
  periodFrom: string;
  periodTo: string;
  postedEntries: number;
  balanceDeltaCents: number;
  unreconciledBankLines: number;
  draftDocuments: number;
  readyToClose: boolean;
  warnings: string[];
};

export type OdooCutoff = {
  id: number;
  cutoffType: "accrued_expense" | "accrued_revenue" | "prepaid_expense" | "prepaid_revenue";
  cutoffDate: string;
  state: "draft" | "done";
  moveRef: string;
  lineCount: number;
};

export type OdooFiscalYearClose = {
  id: number;
  name: string;
  year: number;
  state: "draft" | "calculated" | "in_progress" | "done" | "cancelled";
  dateStart: string;
  dateEnd: string;
  dateOpening: string | null;
};

// ─── MIS / TFRS reports (OCA mis-builder template definitions) ──────────────

export type MisCell = {
  value: number;
  display: string;
  style?: string;
};

export type MisRow = {
  name: string;
  label: string;
  sequence: number;
  description?: string;
  style?: string;
  isHeader?: boolean;
  cells: MisCell[];
};

export type MisPeriod = {
  name: string;
  label: string;
  dateFrom: string;
  dateTo: string;
};

export type MisReport = {
  templateId: number;
  templateName: string;
  kind: "BS" | "PL" | "TB" | "CUSTOM";
  periods: MisPeriod[];
  rows: MisRow[];
  computedAt: string;
  currency: string;
  templateSource: "odoo" | "fallback";
  warning?: string;
};

export type MisListEntry = {
  id: number;
  name: string;
  kind: "BS" | "PL" | "TB" | "CUSTOM";
  fromOdoo: boolean;
};


// ─── PP.30 + Input VAT + PND types ─────────────────────────────────────────

export type Pp30Recon = {
  period: string;
  pp30: {
    outputVatGrossCents: number;
    refundedVatCents: number;
    outputVatNetCents: number;
    inputVatClaimedCents: number;
    netVatPayableCents: number;
  };
  gl: {
    outputVatCreditCents: number;
    outputVatDebitCents: number;
    outputVatNetCents: number;
    inputVatDebitCents: number;
    inputVatCreditCents: number;
    inputVatNetCents: number;
    deferredOutputCents: number;
    deferredInputCents: number;
  };
  delta: { outputVatCents: number; inputVatCents: number };
  reconciled: boolean;
  source: { journalEntryCount: number; vendorBillCount: number };
};

export type PndForm = "PND3" | "PND53" | "PND54";

export type PndRow = {
  seq: number;
  supplierId: string;
  supplierName: string;
  supplierLegalName: string;
  supplierTin: string | null;
  supplierBranchCode: string;
  whtCategory: string;
  whtCategoryLabel: string;
  rdSection: string;
  rateBp: number;
  paidNetCents: number;
  whtCents: number;
  billCount: number;
};

export type PndReport = {
  form: PndForm;
  period: string;
  rows: PndRow[];
  totals: {
    paidNetCents: number;
    whtCents: number;
    billCount: number;
    supplierCount: number;
  };
};

export type InputVatExpiryRow = {
  billId: string;
  internalNumber: string;
  supplierId: string;
  supplierName: string;
  supplierTin: string | null;
  billDate: string;
  taxPointDate: string;
  vatCents: number;
  status: "claimed" | "reclassified" | "claimable" | "expiring_soon" | "expired";
  daysRemaining: number;
  claimDeadline: string;
  billStatus: "draft" | "posted" | "partially_paid" | "paid" | "void";
  reclassifiedAt: string | null;
};
export type InputVatExpiry = {
  asOf: string;
  totals: {
    claimed: { count: number; vatCents: number };
    reclassified: { count: number; vatCents: number };
    claimable: { count: number; vatCents: number };
    expiringSoon: { count: number; vatCents: number };
    expired: { count: number; vatCents: number };
  };
  rows: InputVatExpiryRow[];
};
export type ReclassPreview = {
  billId: string;
  internalNumber: string;
  supplierName: string;
  taxPointDate: string;
  claimDeadline: string;
  daysOverdue: number;
  vatCents: number;
}[];
export type ReclassRunResult = {
  asOf: string;
  dryRun: boolean;
  reclassed: number;
  totalReclassedCents: number;
  rows: Array<{
    billId: string;
    internalNumber: string;
    vatCents: number;
    journalEntryId: string | null;
    error?: string;
  }>;
};

export type ClosingPreview = {
  periodYear: number;
  periodMonth: number;
  periodLabel: string;
  outputVatCents: number;
  inputVatCents: number;
  netPayableCents: number;
  branch: "payable" | "refund" | "wash" | "noop";
  source: { contributingOrderCount: number; contributingBillCount: number };
  blueprintLines: Array<{
    accountCode: string;
    accountName: string;
    debitCents: number;
    creditCents: number;
  }>;
  alreadyFiled: boolean;
  filing: Pp30Filing | null;
};

export type Pp30Filing = {
  id: string;
  periodYear: number;
  periodMonth: number;
  outputVatCents: number;
  inputVatCents: number;
  netPayableCents: number;
  status: "filed" | "amended";
  closingJournalId: string | null;
  filedAt: string;
  filedBy: string | null;
  rdFilingReference: string | null;
  notes: string | null;
};

export type CloseResult = {
  filing: Pp30Filing;
  closingJournalId: string;
  branch: ClosingPreview["branch"];
  stampedOrderCount: number;
  stampedBillCount: number;
};

// ─── PP.30.2 Amendment ─────────────────────────────────────────────────────

export type Pp30AmendmentPreview = {
  periodYear: number;
  periodMonth: number;
  periodLabel: string;
  previous: {
    id: string;
    outputVatCents: number;
    inputVatCents: number;
    netPayableCents: number;
    status: "filed" | "amended";
    amendmentSequence: number;
    filedAt: string;
    surchargeCents: number;
    additionalVatPayableCents: number;
  };
  recomputed: {
    outputVatCents: number;
    inputVatCents: number;
    netPayableCents: number;
    contributingOrderCount: number;
    contributingBillCount: number;
  };
  delta: {
    addOutputVatCents: number;
    addInputVatCents: number;
    addNetCents: number;
  };
  surcharge: {
    cents: number;
    months: number;
    originalDueDate: string;
    cappedAt200pct: boolean;
  };
  blueprintLines: Array<{
    accountCode: string;
    accountName: string;
    debitCents: number;
    creditCents: number;
  }>;
  noChange: boolean;
};

export type Pp30AmendmentResult = {
  filing: {
    id: string;
    outputVatCents: number;
    inputVatCents: number;
    netPayableCents: number;
    status: "filed";
    amendmentSequence: number;
    filedAt: string;
    surchargeCents: number;
    additionalVatPayableCents: number;
    originalFilingId: string;
  };
  closingJournalId: string;
  branch: "more_payable" | "more_refund" | "wash";
  surchargeCents: number;
  surchargeMonths: number;
  newlyStampedOrderCount: number;
  newlyStampedBillCount: number;
};

// ─── Balance Sheet ──────────────────────────────────────────────────────────

export type FsRow = {
  accountCode: string;
  accountName: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  normalBalance: "debit" | "credit";
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};

export type BalanceSheet = {
  asOf: string;
  assets: { rows: FsRow[]; totalCents: number };
  liabilities: { rows: FsRow[]; totalCents: number };
  equity: { rows: FsRow[]; totalCents: number; netIncomeYtdCents: number };
  totals: { assetsCents: number; liabilitiesPlusEquityCents: number; deltaCents: number };
};

// ─── Profit & Loss ─────────────────────────────────────────────────────────

export type ProfitLoss = {
  from: string;
  to: string;
  revenue: { rows: FsRow[]; totalCents: number };
  expense: { rows: FsRow[]; totalCents: number };
  netIncomeCents: number;
};

// ─── Cash Flow ─────────────────────────────────────────────────────────────

export type CashFlow = {
  from: string;
  to: string;
  cashAccounts: string[];
  operatingCents: number;
  investingCents: number;
  financingCents: number;
  voidedCents: number;
  netChangeCents: number;
  openingCashCents: number;
  closingCashCents: number;
  deltaCents: number;
  bySource: Array<{
    sourceModule: string;
    bucket: "operating" | "investing" | "financing" | "void";
    deltaCents: number;
  }>;
};

// ─── Bank Reconciliation ───────────────────────────────────────────────────

export type BankStatement = {
  id: string;
  cashAccountCode: string;
  bankLabel: string;
  statementFrom: string | null;
  statementTo: string | null;
  openingBalanceCents: number;
  closingBalanceCents: number;
  source: string;
  filename: string | null;
  importedAt: string;
  counts: { unmatched: number; matched: number; ignored: number };
};

export type BankLine = {
  id: string;
  lineNo: number;
  postedAt: string;
  amountCents: number;
  description: string | null;
  bankRef: string | null;
  status: "unmatched" | "matched" | "ignored";
  journalEntryId: string | null;
  matchedAt: string | null;
  notes: string | null;
};

export type Suggestion = {
  candidate: {
    id: string;
    date: string;
    amountCents: number;
    description: string | null;
    reference: string | null;
    sourceModule: string | null;
    sourceId: string | null;
  };
  score: number;
  reasons: string[];
};

// ─── Fixed Assets ──────────────────────────────────────────────────────────

export type FixedAsset = {
  id: string;
  assetNo: string;
  name: string;
  category: string;
  acquisitionDate: string;
  acquisitionCostCents: number;
  salvageValueCents: number;
  depreciableBaseCents: number;
  usefulLifeMonths: number;
  depreciationMethod: string;
  assetAccountCode: string;
  expenseAccountCode: string;
  accumulatedDepreciationAccount: string;
  depreciationStartDate: string;
  status: "active" | "disposed" | "retired";
  disposedAt: string | null;
  disposalProceedsCents: number | null;
  accumulatedDepreciationCents: number;
  netBookValueCents: number;
  isFullyDepreciated: boolean;
};

// ─── CIT (PND.50 / PND.51) ─────────────────────────────────────────────────

export type CitPreview = {
  fiscalYear: number;
  halfYear: boolean;
  periodFrom: string;
  periodTo: string;
  revenueCents: number;
  expenseCents: number;
  /** §65 ter add-back — sum of flagged non-deductible amounts. */
  nonDeductibleCents: number;
  /** Per-§65-ter-category breakdown of the add-back. */
  nonDeductibleByCategory: Record<NonDeductibleCategory, number>;
  /** expenseCents − nonDeductibleCents — what RD treats as deductible. */
  deductibleExpenseCents: number;
  /** Refined: revenue − deductibleExpense (= accountingNet + nonDeductible). */
  taxableIncomeCents: number;
  /** Pre-add-back number — what the P&L says before §65 ter. */
  accountingNetIncomeCents: number;
  paidInCapitalCents: number;
  annualisedRevenueCents: number;
  taxDueCents: number;
  rateBracket: "sme" | "flat20";
  breakdown: Array<{ label: string; baseCents: number; rate: number; taxCents: number }>;
  whtCreditsCents: number;
  advancePaidCents: number;
  netPayableCents: number;
  alreadyFiled: boolean;
  filing: {
    id: string;
    filedAt: string;
    filedBy: string | null;
    rdFilingReference: string | null;
    notes: string | null;
    netPayableCents: number;
  } | null;
  warnings: string[];
};

// ─── §65 ter — non-deductible expense register ─────────────────────────────

export type NonDeductibleCategory =
  | "entertainment_over_cap"
  | "personal"
  | "capital_expensed"
  | "donations_over_cap"
  | "fines_penalties"
  | "cit_self"
  | "reserves_provisions"
  | "non_business"
  | "excessive_depreciation"
  | "undocumented"
  | "foreign_overhead"
  | "other";

export type NonDeductibleCapMath = {
  capCents: number;
  spentCents: number;
  overCapCents: number;
  reason: string;
  account: string;
};

// ─── PP.36 — self-assessment VAT on imports of services ───────────────────

export type Pp36Row = {
  paymentId: string;
  billId: string;
  billInternalNumber: string;
  paymentDate: string;
  paymentNo: number;
  supplierId: string;
  supplierName: string;
  supplierLegalName: string;
  supplierForeignId: string | null;
  currency: string;
  fxRateToThb: number;
  amountCents: number;
  amountThbCents: number;
  vatThbCents: number;
};

export type Pp36Report = {
  period: string;
  rate: number;
  rows: Pp36Row[];
  totals: {
    paymentCount: number;
    supplierCount: number;
    baseThbCents: number;
    vatThbCents: number;
  };
  currencies: string[];
  filingDueDate: string;
};

export type NonDeductibleRegister = {
  fiscalYear: number;
  halfYear: boolean;
  periodFrom: string;
  periodTo: string;
  totalCents: number;
  byCategory: Record<NonDeductibleCategory, number>;
  caps: {
    entertainment: NonDeductibleCapMath & { eligibleSpentCents: number };
    donations: NonDeductibleCapMath;
  };
  rows: Array<{
    jeLineId: string;
    journalEntryId: string;
    entryDate: string;
    accountCode: string;
    accountName: string;
    category: NonDeductibleCategory;
    cents: number;
    reason: string | null;
    description: string | null;
  }>;
  suggestions: Array<{
    jeLineId: string;
    accountCode: string;
    accountName: string;
    suggestedCategory: NonDeductibleCategory;
    suggestedCents: number;
    reason: string;
  }>;
};
