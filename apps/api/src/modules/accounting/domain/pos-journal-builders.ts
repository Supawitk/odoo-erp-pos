import { JournalEntry } from './journal-entry';

/**
 * Pure builders for the four POS-related journal entries. Used by both the
 * live event handlers (on-order-completed-journal, on-stock-consumed-cogs)
 * and the backfill service. Keeping them framework-free + side-effect-free
 * makes the same code path testable in isolation and replayable from history.
 *
 * The account-code map (channel → 1110/1120/1135 etc.) is the only domain
 * decision encoded here. CoA names are kept inline so the journal entry has
 * human-readable lines without a CoA round-trip.
 */

export type PaymentMethod = 'cash' | 'card' | 'promptpay' | 'qr' | string;

export function paymentToAccount(method: PaymentMethod): string {
  switch (method) {
    case 'cash':
      return '1110';
    case 'card':
      return '1135';
    case 'promptpay':
    case 'qr':
      return '1120';
    default:
      return '1110';
  }
}

const NAMES: Record<string, string> = {
  '1110': 'Cash on hand',
  '1120': 'Bank — checking',
  '1135': 'Card settlement in transit',
  '1161': 'Finished goods',
  '2201': 'Output VAT',
  '4110': 'Sales revenue — products',
  '4140': 'Sales returns',
  '5100': 'COGS — products',
};
export function accountName(code: string): string {
  return NAMES[code] ?? code;
}

export function vatFromBreakdown(v: unknown): number {
  if (!v || typeof v !== 'object') return 0;
  const obj = v as Record<string, unknown>;
  if (typeof obj.totalVatCents === 'number') return obj.totalVatCents;
  if (typeof obj.vatCents === 'number') return obj.vatCents;
  if (Array.isArray(obj.lines)) {
    return obj.lines.reduce(
      (s: number, l: any) => s + (Number(l?.vatCents) || 0),
      0,
    );
  }
  return 0;
}

export function dateOnly(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString().slice(0, 10);
  const x = d instanceof Date ? d : new Date(d);
  return x.toISOString().slice(0, 10);
}

export interface PosSaleJournalInput {
  date: string;
  orderId: string;
  documentNumber: string | null;
  channelAccount: string;
  netCents: number;
  vatCents: number;
  currency: string;
}

export function buildSaleEntry(opts: PosSaleJournalInput): JournalEntry {
  const lines = [
    {
      accountCode: opts.channelAccount,
      accountName: accountName(opts.channelAccount),
      debitCents: opts.netCents + opts.vatCents,
      creditCents: 0,
    },
    {
      accountCode: '4110',
      accountName: accountName('4110'),
      debitCents: 0,
      creditCents: opts.netCents,
    },
  ];
  if (opts.vatCents > 0) {
    lines.push({
      accountCode: '2201',
      accountName: accountName('2201'),
      debitCents: 0,
      creditCents: opts.vatCents,
    });
  }
  return JournalEntry.create({
    date: opts.date,
    description: `POS sale ${opts.documentNumber ?? opts.orderId.slice(0, 8)}`,
    reference: opts.documentNumber ?? null,
    sourceModule: 'pos',
    sourceId: opts.orderId,
    currency: opts.currency,
    lines,
  });
}

export function buildRefundEntry(opts: PosSaleJournalInput): JournalEntry {
  const lines = [
    {
      accountCode: '4140',
      accountName: accountName('4140'),
      debitCents: opts.netCents,
      creditCents: 0,
    },
  ];
  if (opts.vatCents > 0) {
    lines.push({
      accountCode: '2201',
      accountName: accountName('2201'),
      debitCents: opts.vatCents,
      creditCents: 0,
    });
  }
  lines.push({
    accountCode: opts.channelAccount,
    accountName: accountName(opts.channelAccount),
    debitCents: 0,
    creditCents: opts.netCents + opts.vatCents,
  });
  return JournalEntry.create({
    date: opts.date,
    description: `POS refund ${opts.documentNumber ?? opts.orderId.slice(0, 8)}`,
    reference: opts.documentNumber ?? null,
    sourceModule: 'pos',
    sourceId: opts.orderId,
    currency: opts.currency,
    lines,
  });
}

export interface PosCogsJournalInput {
  /** Use the order date so COGS lands in the same period as the sale. */
  date: string;
  orderId: string;
  totalCostCents: number;
  isRefund: boolean;
  currency: string;
}

export function buildCogsEntry(opts: PosCogsJournalInput): JournalEntry {
  const cost = Math.abs(opts.totalCostCents);
  const lines = opts.isRefund
    ? [
        {
          accountCode: '1161',
          accountName: accountName('1161'),
          debitCents: cost,
          creditCents: 0,
        },
        {
          accountCode: '5100',
          accountName: accountName('5100'),
          debitCents: 0,
          creditCents: cost,
        },
      ]
    : [
        {
          accountCode: '5100',
          accountName: accountName('5100'),
          debitCents: cost,
          creditCents: 0,
        },
        {
          accountCode: '1161',
          accountName: accountName('1161'),
          debitCents: 0,
          creditCents: cost,
        },
      ];
  return JournalEntry.create({
    date: opts.date,
    description: opts.isRefund
      ? `COGS reversal for refund ${opts.orderId.slice(0, 8)}`
      : `COGS for sale ${opts.orderId.slice(0, 8)}`,
    reference: null,
    sourceModule: 'pos-cogs',
    sourceId: opts.orderId,
    currency: opts.currency,
    lines,
  });
}
