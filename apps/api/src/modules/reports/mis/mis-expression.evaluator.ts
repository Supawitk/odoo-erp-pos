import { Injectable, Inject, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Database } from '@erp/db';
import { DRIZZLE } from '../../../shared/infrastructure/database/database.module';
import type { MisKpi } from './mis.types';

/**
 * Evaluates MIS-builder expressions against custom.journal_entry_lines.
 *
 * Supported expression DSL (subset of OCA's mis_builder syntax — covers all
 * KPIs in the shipped Thai BS/PL/TB templates):
 *
 *   bal[1%]      all-time balance (debit - credit, signed by normal_balance)
 *                for accounts whose code matches LIKE '1%'
 *   balp[1%]     period balance (between dateFrom and dateTo)
 *   bali[1%]     initial balance (strictly before dateFrom)
 *   bale[1%]     ending balance (cumulative through dateTo)
 *   crdp[1%]     period credit only
 *   debp[1%]     period debit only
 *   abs(expr)    absolute value
 *   KPI_NAME     reference to another KPI's value in same template
 *   + - * / ()   basic arithmetic
 *
 * Multiple patterns inside [] separated by `,` are unioned (e.g. `bal[1%,2%]`
 * = balance for accounts starting with 1 OR 2).
 *
 * Why not just call mis.report.instance.compute() in Odoo? Because our
 * journal entries live in custom.journal_entry_lines (not Odoo's
 * account.move.line). Compute()-ing in Odoo would silently return zeros.
 * This evaluator preserves the OCA template DEFINITIONS (Thai labels,
 * sequence, styles) while reading our own ledger.
 *
 * Safety: KPI names + balance tokens are extracted via regex, evaluated
 * to numbers, then substituted into the expression string. The remaining
 * string is then sanitised to allow only digits + arithmetic + parens and
 * the literal `Math.abs` keyword before being eval'd via `new Function()`.
 * Even if a malicious template was somehow uploaded, it cannot inject
 * arbitrary code.
 */
@Injectable()
export class MisExpressionEvaluator {
  private readonly logger = new Logger(MisExpressionEvaluator.name);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Evaluate every KPI in `kpis` for one period (dateFrom..dateTo). Returns
   * a Map of kpiName -> numeric baht value (decimal, already converted from
   * cents). KPIs are computed in `sequence` order so cross-references resolve.
   */
  async evaluateAll(
    kpis: MisKpi[],
    dateFrom: Date,
    dateTo: Date,
  ): Promise<Map<string, number>> {
    // Pre-fetch every distinct balance token used across all KPIs in one
    // single SQL pass so we don't issue N round-trips per period.
    const tokens = collectTokens(kpis.map((k) => k.expression || '0').join(' '));
    const tokenValues = await this.computeTokens(tokens, dateFrom, dateTo);

    const sorted = [...kpis].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
    const values = new Map<string, number>();

    for (const kpi of sorted) {
      // AccountingNone is OCA's sentinel for header/group rows — they have no
      // value, just a label. Treat as 0 silently.
      if (!kpi.expression || kpi.expression.trim() === 'AccountingNone') {
        values.set(kpi.name, 0);
        continue;
      }
      try {
        const value = this.evaluateExpression(
          kpi.expression,
          tokenValues,
          values,
        );
        values.set(kpi.name, value);
      } catch (err) {
        this.logger.warn(
          `KPI ${kpi.name} expr=${kpi.expression} failed: ${(err as Error).message}`,
        );
        values.set(kpi.name, 0);
      }
    }
    return values;
  }

  /** Public for unit testing — does the expression sanitisation + eval. */
  evaluateExpression(
    expression: string,
    tokenValues: Map<string, number>,
    kpiValues: Map<string, number>,
  ): number {
    // 1. Substitute balance tokens.
    let expr = expression;
    for (const [token, val] of tokenValues) {
      expr = expr.replaceAll(token, `(${val.toString()})`);
    }
    // 2. Substitute KPI references (longest first to avoid partial replacement
    //    of TOTAL_REVENUE inside REVENUE etc.).
    const kpiNames = [...kpiValues.keys()].sort((a, b) => b.length - a.length);
    for (const name of kpiNames) {
      const val = kpiValues.get(name)!;
      // Match KPI name as a whole word (uppercase identifier).
      expr = expr.replaceAll(
        new RegExp(`\\b${escapeRegex(name)}\\b`, 'g'),
        `(${val.toString()})`,
      );
    }
    // 3. Replace abs() with Math.abs().
    expr = expr.replaceAll(/\babs\b/g, 'Math.abs');
    // 4. Sanitise — only allow digits, basic arithmetic, parens, dots,
    //    whitespace, and the literal "Math.abs".
    const stripped = expr.replaceAll(/Math\.abs/g, '');
    if (!/^[0-9.+\-*/()\s,]*$/.test(stripped)) {
      throw new Error(`unsafe expression after substitution: ${expr}`);
    }
    // 5. Eval. The Function() constructor here is safe because step 4
    //    rejected anything other than arithmetic + Math.abs.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function('Math', `return (${expr || '0'})`);
    const result = fn(Math);
    if (typeof result !== 'number' || Number.isNaN(result)) {
      throw new Error(`expression returned non-number: ${expr} -> ${result}`);
    }
    return result;
  }

  /**
   * Run one SQL query per token. We deliberately do NOT batch ALL tokens
   * into one giant UNION ALL because the WHERE clauses differ wildly
   * (different prefix lists, different period qualifiers) — keeping each
   * token as its own query is clearer and the round-trip is local.
   */
  private async computeTokens(
    tokens: TokenSpec[],
    dateFrom: Date,
    dateTo: Date,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tokens.length === 0) return out;

    const fromIso = dateFrom.toISOString().slice(0, 10);
    const toIso = dateTo.toISOString().slice(0, 10);

    for (const tok of tokens) {
      const likeClauses = tok.prefixes.map(
        (p) => sql`l.account_code LIKE ${p}`,
      );
      const orClause = sql.join(likeClauses, sql` OR `);

      // Period filter:
      //   p (period) — between fromIso and toIso (inclusive)
      //   i (initial) — strictly before fromIso
      //   e (ending) — through toIso (inclusive)
      //   no qualifier (all-time) — no date filter
      let dateFilter;
      if (tok.qualifier === 'p') {
        dateFilter = sql`AND je.date >= ${fromIso}::date AND je.date <= ${toIso}::date`;
      } else if (tok.qualifier === 'i') {
        dateFilter = sql`AND je.date < ${fromIso}::date`;
      } else if (tok.qualifier === 'e') {
        dateFilter = sql`AND je.date <= ${toIso}::date`;
      } else {
        dateFilter = sql``;
      }

      // Aggregation: bal/balp/bali/bale = signed by normal_balance.
      // crd*/deb* = unsigned credit/debit total.
      let select;
      if (tok.kind === 'bal') {
        select = sql`COALESCE(SUM(
          CASE WHEN c.normal_balance = 'debit'
            THEN l.debit_cents - l.credit_cents
            ELSE l.credit_cents - l.debit_cents
          END
        ), 0)`;
      } else if (tok.kind === 'crd') {
        select = sql`COALESCE(SUM(l.credit_cents), 0)`;
      } else {
        // 'deb'
        select = sql`COALESCE(SUM(l.debit_cents), 0)`;
      }

      const rows = await this.db.execute<{ v: string }>(
        sql`
          SELECT (${select})::text AS v
          FROM custom.journal_entry_lines l
          JOIN custom.journal_entries je ON je.id = l.journal_entry_id
          JOIN custom.chart_of_accounts c ON c.code = l.account_code
          WHERE je.status = 'posted'
            AND (${orClause})
            ${dateFilter}
        `,
      );
      const cents = Number(rows[0]?.v ?? 0);
      const baht = cents / 100;
      out.set(tok.token, baht);
    }
    return out;
  }
}

interface TokenSpec {
  /** Original token string e.g. "balp[4%]". */
  token: string;
  /** 'bal' (signed balance) | 'crd' (credit) | 'deb' (debit). */
  kind: 'bal' | 'crd' | 'deb';
  /** Period qualifier: '' (all-time) | 'p' (period) | 'i' (initial) | 'e' (ending). */
  qualifier: '' | 'p' | 'i' | 'e';
  /** SQL LIKE patterns from the brackets (e.g. ['1%', '2%']). */
  prefixes: string[];
}

const TOKEN_RE = /\b(bal|crd|deb)([pie]?)\[([^\]]+)\]/g;

function collectTokens(combined: string): TokenSpec[] {
  const seen = new Map<string, TokenSpec>();
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(combined))) {
    const token = m[0];
    if (seen.has(token)) continue;
    const prefixes = m[3]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    seen.set(token, {
      token,
      kind: m[1] as 'bal' | 'crd' | 'deb',
      qualifier: (m[2] || '') as '' | 'p' | 'i' | 'e',
      prefixes,
    });
  }
  return [...seen.values()];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
