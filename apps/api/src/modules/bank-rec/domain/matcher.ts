/**
 * Bank-line ↔ JE-line matcher. Pure scoring function — no DB access. The
 * caller (BankRecService) feeds in candidate JE lines drawn from a date
 * window around the bank line and lets us score each one.
 *
 * Scoring (0..100):
 *   exact amount + same date  → 100 (best)
 *   exact amount + ±N days    → 90 − (5 × |daysOff|)
 *   amount within 0.1%        → 70
 *   amount mismatch           → ≤ 30 (handled by caller as "ignored")
 *
 * + reference-text similarity bonus: shared substring of length ≥ 4 in
 *   description → +5 per match (capped at +15).
 *
 * Anything ≥ 70 is auto-suggestable. Anything < 70 is shown as "weak"
 * suggestion and requires explicit human pick.
 */

export interface BankLine {
  id: string;
  postedAt: string; // YYYY-MM-DD
  amountCents: number;
  description: string;
  bankRef: string | null;
}

export interface JournalCandidate {
  /** Journal entry id. */
  id: string;
  /** JE date (YYYY-MM-DD). */
  date: string;
  /** Signed: positive = debit to cash account (inflow), neg = credit (outflow).
   * Already filtered to the matching cash account by the SQL caller. */
  amountCents: number;
  description: string | null;
  reference: string | null;
  sourceModule: string | null;
  sourceId: string | null;
}

export interface MatchSuggestion {
  candidate: JournalCandidate;
  score: number;
  reasons: string[];
}

export function suggestMatches(
  bankLine: BankLine,
  candidates: JournalCandidate[],
  opts: { dateWindowDays?: number; minScore?: number } = {},
): MatchSuggestion[] {
  const minScore = opts.minScore ?? 60;
  const suggestions: MatchSuggestion[] = [];
  for (const c of candidates) {
    const s = scoreMatch(bankLine, c, opts.dateWindowDays ?? 3);
    if (s.score >= minScore) suggestions.push(s);
  }
  // Highest score first, then most recent JE first as tiebreaker.
  return suggestions.sort(
    (a, b) => b.score - a.score || b.candidate.date.localeCompare(a.candidate.date),
  );
}

export function scoreMatch(
  bank: BankLine,
  je: JournalCandidate,
  dateWindowDays: number,
): MatchSuggestion {
  const reasons: string[] = [];
  let score = 0;

  const amountDelta = Math.abs(bank.amountCents - je.amountCents);
  if (amountDelta === 0) {
    score = 100;
    reasons.push('exact amount match');
  } else {
    const tol = Math.max(1, Math.round(Math.abs(bank.amountCents) * 0.001));
    if (amountDelta <= tol) {
      score = 70;
      reasons.push(`amount within 0.1% (Δ${amountDelta})`);
    } else {
      // Anything bigger isn't a match candidate — return early.
      return { candidate: je, score: 0, reasons: ['amount mismatch'] };
    }
  }

  // Date proximity penalty. ±0d = 0 penalty, ±N = 5*N penalty up to window.
  const daysOff = daysBetween(bank.postedAt, je.date);
  if (daysOff === 0) {
    reasons.push('same day');
  } else if (daysOff <= dateWindowDays) {
    score -= 5 * daysOff;
    reasons.push(`${daysOff}d apart`);
  } else {
    return { candidate: je, score: 0, reasons: ['outside date window'] };
  }

  // Reference / description text bonus.
  const bonus = textBonus(bank, je);
  if (bonus > 0) {
    score += bonus;
    reasons.push(`text bonus +${bonus}`);
  }

  return { candidate: je, score: Math.min(100, Math.max(0, score)), reasons };
}

/**
 * Hunt for shared substrings of length ≥ 4 between bank desc/ref and JE
 * desc/reference. Each match worth 5, capped at 15. Case-insensitive.
 *
 * Concrete example: bank desc "BBL FT 12345 PROMOPAY 87654" matches a JE
 * with reference "SI2605-000007" — they share "2605" (4 chars) → +5.
 */
function textBonus(bank: BankLine, je: JournalCandidate): number {
  const bankText = `${bank.description ?? ''} ${bank.bankRef ?? ''}`.toLowerCase();
  const jeText = `${je.description ?? ''} ${je.reference ?? ''}`.toLowerCase();
  if (!bankText.trim() || !jeText.trim()) return 0;

  const bankTokens = bankText.match(/[a-z0-9-]{4,}/g) ?? [];
  let bonus = 0;
  for (const tok of bankTokens) {
    if (jeText.includes(tok)) {
      bonus += 5;
      if (bonus >= 15) return 15;
    }
  }
  return bonus;
}

export function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(Math.round((ta - tb) / 86400000));
}

/**
 * Stable fingerprint for dedup across re-imports. SHA-256 of the canonical
 * tuple. Computed in the service via crypto.createHash; pure function here
 * just builds the canonical input string so the test can assert determinism.
 */
export function fingerprintInput(line: ParsedLineForFingerprint): string {
  const ref = (line.bankRef ?? '').trim();
  const desc = (line.description ?? '').trim();
  return `${line.postedAt}|${line.amountCents}|${ref || desc}`;
}

export interface ParsedLineForFingerprint {
  postedAt: string;
  amountCents: number;
  description: string;
  bankRef: string | null;
}
