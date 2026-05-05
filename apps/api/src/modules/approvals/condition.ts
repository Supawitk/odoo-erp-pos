/**
 * Tiny safe expression evaluator for tier_definitions.condition_expr.
 *
 * We deliberately do NOT use `new Function` or `eval`; the language is a
 * fixed set of comparisons against a flat key/value bag the caller provides.
 * Grammar (whitespace-insensitive, regex-tokenised):
 *
 *   expr   := term ((`&&` | `||`) term)*
 *   term   := ident OP literal
 *   OP     := `>` | `>=` | `<` | `<=` | `==` | `!=`
 *   literal:= number | quoted-string | true | false
 *
 * Empty or null expression evaluates to true (rule always applies).
 *
 * This is intentionally minimal — anything more complex should live in code,
 * not in a database string.
 */
export function matchesCondition(
  expr: string | null | undefined,
  ctx: Record<string, unknown>,
): boolean {
  if (!expr || !expr.trim()) return true;

  // Split on top-level && / ||. We don't support parentheses (KISS).
  const tokens = expr.split(/\s*(&&|\|\|)\s*/);
  let result: boolean | null = null;
  let pendingOp: '&&' | '||' | null = null;

  for (const tok of tokens) {
    if (tok === '&&' || tok === '||') {
      pendingOp = tok;
      continue;
    }
    const cur = evalTerm(tok, ctx);
    if (result === null) result = cur;
    else if (pendingOp === '&&') result = result && cur;
    else if (pendingOp === '||') result = result || cur;
  }
  return result ?? true;
}

function evalTerm(term: string, ctx: Record<string, unknown>): boolean {
  const m = term.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(.+?)\s*$/);
  if (!m) {
    // Bare identifier — truthy check.
    const ident = term.trim();
    return !!ctx[ident];
  }
  const [, key, op, raw] = m;
  const lhs = ctx[key];
  const rhs = parseLiteral(raw);

  switch (op) {
    case '>':  return Number(lhs) >  Number(rhs);
    case '>=': return Number(lhs) >= Number(rhs);
    case '<':  return Number(lhs) <  Number(rhs);
    case '<=': return Number(lhs) <= Number(rhs);
    case '==': return lhs === rhs;
    case '!=': return lhs !== rhs;
    default:   return false;
  }
}

function parseLiteral(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1);
  return t; // bare word
}
