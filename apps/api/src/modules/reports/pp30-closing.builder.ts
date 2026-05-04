/**
 * 🇹🇭 PP.30 closing-journal builder — pure, framework-free.
 *
 * Inputs:
 *   outputVatCents — period output VAT, net of CN/DN. From PP30Service.
 *   inputVatCents  — period input VAT to claim. Sum of vendor_bills.vat_cents
 *                    where post-date in/before period AND not reclassed
 *                    AND not yet pp30-claimed.
 *
 * Output: a balanced journal entry blueprint (debit = credit). Two shapes:
 *
 *   net = output − input > 0   (typical):
 *     Dr 2201 Output VAT  outputVatCents
 *       Cr 1155 Input VAT inputVatCents
 *       Cr 2210 VAT payable net  ← the amount we owe RD
 *
 *   net < 0  (input > output, refund-due):
 *     Dr 2201 Output VAT  outputVatCents
 *     Dr 1158 VAT refund |net|
 *       Cr 1155 Input VAT inputVatCents
 *
 *   net = 0  (rare but legal):
 *     Dr 2201 outputVatCents / Cr 1155 inputVatCents (if both > 0)
 *     OR no journal at all (degenerate — caller should not post)
 */

export interface ClosingLine {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
}

export interface ClosingBlueprint {
  outputVatCents: number;
  inputVatCents: number;
  netPayableCents: number;
  branch: 'payable' | 'refund' | 'wash' | 'noop';
  lines: ClosingLine[];
}

export class ClosingBuilderError extends Error {
  constructor(
    public readonly code: 'NEGATIVE_INPUT' | 'NEGATIVE_OUTPUT',
    message: string,
  ) {
    super(message);
    this.name = 'ClosingBuilderError';
  }
}

export function buildClosingBlueprint(
  outputVatCents: number,
  inputVatCents: number,
): ClosingBlueprint {
  if (!Number.isFinite(outputVatCents) || outputVatCents < 0) {
    throw new ClosingBuilderError(
      'NEGATIVE_OUTPUT',
      `outputVatCents must be ≥ 0 (got ${outputVatCents})`,
    );
  }
  if (!Number.isFinite(inputVatCents) || inputVatCents < 0) {
    throw new ClosingBuilderError(
      'NEGATIVE_INPUT',
      `inputVatCents must be ≥ 0 (got ${inputVatCents})`,
    );
  }
  const net = outputVatCents - inputVatCents;
  const lines: ClosingLine[] = [];

  if (outputVatCents > 0) {
    lines.push({
      accountCode: '2201',
      accountName: 'ภาษีขาย (Output VAT)',
      debitCents: outputVatCents,
      creditCents: 0,
    });
  }
  if (inputVatCents > 0) {
    lines.push({
      accountCode: '1155',
      accountName: 'ภาษีซื้อ (Input VAT)',
      debitCents: 0,
      creditCents: inputVatCents,
    });
  }
  if (net > 0) {
    lines.push({
      accountCode: '2210',
      accountName: 'ภาษีมูลค่าเพิ่มค้างจ่าย (PP.30 net)',
      debitCents: 0,
      creditCents: net,
    });
  } else if (net < 0) {
    lines.push({
      accountCode: '1158',
      accountName: 'ภาษีมูลค่าเพิ่มรอเรียกคืน (PP.30 refund)',
      debitCents: -net,
      creditCents: 0,
    });
  }

  // Sanity: every blueprint must balance.
  const dr = lines.reduce((s, l) => s + l.debitCents, 0);
  const cr = lines.reduce((s, l) => s + l.creditCents, 0);
  if (dr !== cr) {
    // This should be impossible given the math above; surface loud rather than
    // silently let a corrupt entry through to JournalEntry.create().
    throw new Error(
      `closing blueprint unbalanced: debits=${dr} credits=${cr} ` +
        `(output=${outputVatCents} input=${inputVatCents} net=${net})`,
    );
  }

  const branch =
    outputVatCents === 0 && inputVatCents === 0
      ? 'noop'
      : net > 0
      ? 'payable'
      : net < 0
      ? 'refund'
      : 'wash';

  return {
    outputVatCents,
    inputVatCents,
    netPayableCents: net,
    branch,
    lines,
  };
}
