/**
 * 🇹🇭 PP.30.2 amendment-journal builder — pure, framework-free.
 *
 * The original close moved the period's full output VAT into 2210 (or 1158 if
 * refund-direction). When an amendment finds additional sales or bills that
 * weren't included originally, those are sitting in 2201 / 1155 again from
 * their post-close source events. The amendment journal moves the *delta* —
 * never the full re-computed amount — out of those holding accounts.
 *
 *   addOutputVat  = recomputedOutput − previousOutput   (≥ 0 in normal case)
 *   addInputVat   = recomputedInput  − previousInput    (≥ 0 in normal case)
 *   addNet        = addOutputVat − addInputVat          (signed)
 *   surcharge     = §27 surcharge on max(addNet, 0)     (≥ 0)
 *
 * Journal shapes:
 *
 *   addNet > 0 (more payable):
 *     Dr 2201 Output VAT      addOutputVat
 *     Dr 6390 Surcharge       surcharge      (only if surcharge > 0)
 *       Cr 1155 Input VAT     addInputVat
 *       Cr 2210 VAT payable   addNet + surcharge
 *
 *   addNet < 0 (refund got bigger — input grew faster than output):
 *     Dr 2201 Output VAT      addOutputVat
 *     Dr 1158 VAT refund      |addNet|
 *       Cr 1155 Input VAT     addInputVat
 *
 *   addNet = 0 with surcharge (rare — happens when negative deltas net but the
 *   user wants to record a separate surcharge for some other reason): treated
 *   as "wash" — only the surcharge journal lines apply. We keep the door closed
 *   on this for now: callers should compute surcharge from POSITIVE additional
 *   VAT only, so addNet=0 implies surcharge=0.
 */

export interface AmendmentLine {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
}

export interface AmendmentBlueprint {
  addOutputVatCents: number;
  addInputVatCents: number;
  /** Signed: positive = more payable, negative = more refund. */
  addNetCents: number;
  surchargeCents: number;
  branch: 'more_payable' | 'more_refund' | 'wash';
  lines: AmendmentLine[];
}

export class AmendmentBuilderError extends Error {
  constructor(
    public readonly code: 'NO_DELTA' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'AmendmentBuilderError';
  }
}

export function buildAmendmentBlueprint(input: {
  addOutputVatCents: number;
  addInputVatCents: number;
  surchargeCents: number;
}): AmendmentBlueprint {
  const { addOutputVatCents, addInputVatCents, surchargeCents } = input;
  if (
    !Number.isFinite(addOutputVatCents) ||
    !Number.isFinite(addInputVatCents) ||
    !Number.isFinite(surchargeCents)
  ) {
    throw new AmendmentBuilderError(
      'INVALID_INPUT',
      `addOutputVatCents/addInputVatCents/surchargeCents must be finite`,
    );
  }
  if (surchargeCents < 0) {
    throw new AmendmentBuilderError(
      'INVALID_INPUT',
      `surchargeCents must be ≥ 0 (got ${surchargeCents})`,
    );
  }

  const addNet = addOutputVatCents - addInputVatCents;
  const lines: AmendmentLine[] = [];

  if (addOutputVatCents > 0) {
    lines.push({
      accountCode: '2201',
      accountName: 'ภาษีขาย (Output VAT — amendment)',
      debitCents: addOutputVatCents,
      creditCents: 0,
    });
  } else if (addOutputVatCents < 0) {
    // Reverse direction — output VAT was OVER-stated originally, so we credit
    // 2201 to put it back (rare; means a sale was voided post-filing).
    lines.push({
      accountCode: '2201',
      accountName: 'ภาษีขาย (Output VAT — amendment reversal)',
      debitCents: 0,
      creditCents: -addOutputVatCents,
    });
  }

  if (addInputVatCents > 0) {
    lines.push({
      accountCode: '1155',
      accountName: 'ภาษีซื้อ (Input VAT — amendment)',
      debitCents: 0,
      creditCents: addInputVatCents,
    });
  } else if (addInputVatCents < 0) {
    lines.push({
      accountCode: '1155',
      accountName: 'ภาษีซื้อ (Input VAT — amendment reversal)',
      debitCents: -addInputVatCents,
      creditCents: 0,
    });
  }

  if (surchargeCents > 0) {
    lines.push({
      accountCode: '6390',
      accountName: 'เบี้ยปรับ §27 (PP.30.2 surcharge — non-deductible)',
      debitCents: surchargeCents,
      creditCents: 0,
    });
  }

  // Net effect on the payable/refund accounts.
  // addNet > 0 (more payable): credit 2210
  // addNet < 0 (more refund): debit 1158
  // addNet = 0: no payable/refund movement
  const totalPayableMovement = addNet + surchargeCents;
  if (addNet > 0) {
    lines.push({
      accountCode: '2210',
      accountName: 'ภาษีมูลค่าเพิ่มค้างจ่าย (PP.30.2 net + surcharge)',
      debitCents: 0,
      creditCents: totalPayableMovement,
    });
  } else if (addNet < 0) {
    // Refund grew. Surcharge in this branch is 0 (callers enforce this).
    lines.push({
      accountCode: '1158',
      accountName: 'ภาษีมูลค่าเพิ่มรอเรียกคืน (PP.30.2 refund)',
      debitCents: -addNet,
      creditCents: 0,
    });
  } else if (surchargeCents > 0) {
    // addNet=0 but a surcharge applies — credit 2210 for the surcharge alone.
    lines.push({
      accountCode: '2210',
      accountName: 'ภาษีมูลค่าเพิ่มค้างจ่าย (PP.30.2 surcharge)',
      debitCents: 0,
      creditCents: surchargeCents,
    });
  }

  // No-delta guard: if every single line is zero, refuse to build.
  const dr = lines.reduce((s, l) => s + l.debitCents, 0);
  const cr = lines.reduce((s, l) => s + l.creditCents, 0);
  if (dr === 0 && cr === 0) {
    throw new AmendmentBuilderError(
      'NO_DELTA',
      `Amendment has no effect — addOutput=${addOutputVatCents} addInput=${addInputVatCents} surcharge=${surchargeCents}`,
    );
  }
  if (dr !== cr) {
    throw new Error(
      `amendment blueprint unbalanced: debits=${dr} credits=${cr} ` +
        `(addOut=${addOutputVatCents} addIn=${addInputVatCents} surcharge=${surchargeCents} addNet=${addNet})`,
    );
  }

  const branch: AmendmentBlueprint['branch'] =
    addNet > 0 ? 'more_payable' : addNet < 0 ? 'more_refund' : 'wash';

  return {
    addOutputVatCents,
    addInputVatCents,
    addNetCents: addNet,
    surchargeCents,
    branch,
    lines,
  };
}
