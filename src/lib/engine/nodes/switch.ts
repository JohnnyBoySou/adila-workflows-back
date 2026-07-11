import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Switch n-ário — avalia regras independentes (left/op/right/dataType) em ordem.
 * A primeira regra verdadeira define `nextLabel = rule.label`. Se nenhuma casar,
 * `nextLabel = default ?? "default"`.
 *
 * Config (formato novo):
 *   {
 *     rules: Array<{
 *       left: any,         // templatable
 *       op: string,        // eq / neq / gt / lt / gte / lte / contains / ncontains / startsWith / endsWith / regex / isEmpty / notEmpty
 *       dataType: string,  // string | number | boolean | dateTime
 *       right: any,        // templatable (ignorado em ops unárias)
 *       label: string,     // label da aresta que segue se for true
 *     }>,
 *     default?: string,    // default: "default"
 *   }
 *
 * Compat: aceita também o formato legado `{ value, cases: [{match, label}], default }`.
 */

type DataType = "string" | "number" | "boolean" | "dateTime";

function coerce(v: unknown, type: DataType): unknown {
  if (type === "string") return v == null ? "" : typeof v === "string" ? v : String(v);
  if (type === "number") {
    if (typeof v === "number") return v;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  if (type === "boolean") {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.toLowerCase().trim() === "true";
    return Boolean(v);
  }
  if (type === "dateTime") {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : t;
    }
    return null;
  }
  return v;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function evaluate(left: unknown, op: string, right: unknown, dataType: DataType): boolean {
  if (op === "isEmpty") return isEmpty(left);
  if (op === "notEmpty") return !isEmpty(left);
  const l = coerce(left, dataType);
  const r = coerce(right, dataType);
  switch (op) {
    case "eq":
      return l === r;
    case "neq":
      return l !== r;
    case "gt":
      return (l as number) > (r as number);
    case "gte":
      return (l as number) >= (r as number);
    case "lt":
      return (l as number) < (r as number);
    case "lte":
      return (l as number) <= (r as number);
    case "contains":
      return String(l ?? "").includes(String(r ?? ""));
    case "ncontains":
      return !String(l ?? "").includes(String(r ?? ""));
    case "startsWith":
      return String(l ?? "").startsWith(String(r ?? ""));
    case "endsWith":
      return String(l ?? "").endsWith(String(r ?? ""));
    case "regex": {
      try {
        return new RegExp(String(r ?? "")).test(String(l ?? ""));
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

interface Rule {
  left: unknown;
  op: string;
  dataType: DataType;
  right: unknown;
  label: string;
}

function isRule(v: unknown): v is Rule {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.label === "string" && typeof r.op === "string";
}

export const switchHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const defaultLabel = typeof cfg.default === "string" && cfg.default ? cfg.default : "default";

  // Formato novo: rules independentes.
  const rules = Array.isArray(cfg.rules) ? cfg.rules.filter(isRule) : [];
  if (rules.length > 0) {
    for (const r of rules) {
      const dt: DataType =
        r.dataType === "number" || r.dataType === "boolean" || r.dataType === "dateTime"
          ? r.dataType
          : "string";
      if (evaluate(r.left, r.op, r.right, dt)) {
        return {
          output: { matched: r.label, op: r.op, dataType: dt, left: r.left, right: r.right },
          nextLabel: r.label,
        };
      }
    }
    return {
      output: { matched: defaultLabel, reason: "no_rule_matched" },
      nextLabel: defaultLabel,
    };
  }

  // Compat: formato legado { value, cases: [{match, label}], default }.
  interface LegacyCase {
    match: unknown;
    label: string;
  }
  const isLegacyCase = (c: unknown): c is LegacyCase =>
    !!c &&
    typeof c === "object" &&
    "label" in c &&
    typeof (c as Record<string, unknown>).label === "string";
  const value = cfg.value;
  const cases = Array.isArray(cfg.cases) ? cfg.cases.filter(isLegacyCase) : [];
  for (const c of cases) {
    if (value === c.match) {
      return { output: { value, matched: c.label }, nextLabel: c.label };
    }
  }
  return { output: { value, matched: defaultLabel }, nextLabel: defaultLabel };
};
