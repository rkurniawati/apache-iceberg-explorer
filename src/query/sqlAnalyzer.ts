import { parse, Statement, SelectFromStatement } from 'pgsql-ast-parser';

export interface QueryAnalysis {
  /** The limit requested by the user, if explicitly specified. */
  requestedLimit?: number;
  /** Whether the query is a pure projection scan without filtering, aggregation, joins, or sorting. */
  isSimpleScan: boolean;
  /** Whether the query contains filters, aggregations, transformations, or joins. */
  hasFilterOrTransform: boolean;
}

const AGGREGATE_FUNCTIONS = new Set(['count', 'sum', 'avg', 'min', 'max', 'approx_count_distinct']);

function hasAggregateExpr(expr: any): boolean {
  if (!expr || typeof expr !== 'object') {
    return false;
  }
  if (expr.type === 'call' && expr.function && typeof expr.function.name === 'string') {
    if (AGGREGATE_FUNCTIONS.has(expr.function.name.toLowerCase())) {
      return true;
    }
  }
  for (const key of Object.keys(expr)) {
    if (key === 'type') {
      continue;
    }
    const val = expr[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (hasAggregateExpr(item)) {
          return true;
        }
      }
    } else if (val && typeof val === 'object') {
      if (hasAggregateExpr(val)) {
        return true;
      }
    }
  }
  return false;
}

export function analyzeQuery(sql: string): QueryAnalysis {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { isSimpleScan: true, hasFilterOrTransform: false };
  }

  try {
    const ast: Statement[] = parse(trimmed);
    if (ast.length === 1 && ast[0].type === 'select') {
      const sel = ast[0] as SelectFromStatement;

      let requestedLimit: number | undefined;
      if (sel.limit && sel.limit.limit) {
        if (sel.limit.limit.type === 'integer') {
          requestedLimit = sel.limit.limit.value;
        } else if (sel.limit.limit.type === 'numeric' && typeof (sel.limit.limit as any).value === 'number') {
          requestedLimit = (sel.limit.limit as any).value;
        }
      }

      const hasWhere = Boolean(sel.where);
      const hasGroupBy = Boolean(sel.groupBy && sel.groupBy.length > 0);
      const hasOrderBy = Boolean(sel.orderBy && sel.orderBy.length > 0);
      const hasDistinct = Boolean(sel.distinct);
      const hasMultipleFromOrJoin = Boolean(
        sel.from && (sel.from.length > 1 || sel.from.some((f: any) => Boolean(f.join))),
      );
      const hasAggregates = Boolean(
        sel.columns && sel.columns.some((c: any) => hasAggregateExpr(c.expr)),
      );

      const hasFilterOrTransform =
        hasWhere || hasGroupBy || hasOrderBy || hasDistinct || hasMultipleFromOrJoin || hasAggregates;

      return {
        requestedLimit,
        isSimpleScan: !hasFilterOrTransform,
        hasFilterOrTransform,
      };
    }
  } catch {
    // Fallback to regex analysis if AST parsing fails on custom DuckDB dialect syntax
  }

  // Regex fallback:
  // Remove block and line comments, and string literals to avoid false positives
  const sanitized = trimmed
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

  let requestedLimit: number | undefined;
  const limitMatch = sanitized.match(/\bLIMIT\s+(\d+)\b/i);
  if (limitMatch) {
    requestedLimit = parseInt(limitMatch[1], 10);
  }

  const hasFilterOrTransform =
    /\b(WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|JOIN|DISTINCT|UNION|INTERSECT|EXCEPT)\b/i.test(sanitized) ||
    /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(sanitized);

  return {
    requestedLimit,
    isSimpleScan: !hasFilterOrTransform,
    hasFilterOrTransform,
  };
}
