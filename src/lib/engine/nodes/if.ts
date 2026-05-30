import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Condicional n8n-style. Avalia uma expressão e ramifica via labels de aresta.
 *
 * Config:
 *   - left: any (templatable)
 *   - op:   identificador do operador (eq, neq, gt, contains, startsWith, ...)
 *   - right?: any (templatable, ignorado em ops unárias)
 *   - dataType?: "string" | "number" | "dateTime" | "boolean" | "array" | "object"
 *
 * Saída: nextLabel = "true" | "false". A definition precisa ter arestas
 * saindo com esses labels.
 *
 * IMPORTANTE: `evaluate` + `coerce` ESPELHAM as funções em
 * front/app/components/flow/node-config/if-panel.tsx. Mantenha as duas
 * implementações em sync — divergir significa preview mentir pro usuário.
 */

type DataType = "string" | "number" | "dateTime" | "boolean" | "array" | "object";

function coerce(v: unknown, t: DataType): unknown {
  if (t === "string") {
    if (v == null) return "";
    return typeof v === "string" ? v : String(v);
  }
  if (t === "number") return typeof v === "number" ? v : Number(v);
  if (t === "boolean") {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.toLowerCase() === "true";
    return Boolean(v);
  }
  return v;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function arrLen(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  return 0;
}

function evaluate(op: string, left: unknown, right: unknown, dataType: DataType): boolean {
  const lc = coerce(left, dataType);
  const rc = coerce(right, dataType);

  switch (op) {
    case "eq":
      return lc === rc;
    case "neq":
      return lc !== rc;
    case "truthy":
      return Boolean(left);
    case "falsy":
      return !left;
    case "gt":
      return Number(lc) > Number(rc);
    case "gte":
      return Number(lc) >= Number(rc);
    case "lt":
      return Number(lc) < Number(rc);
    case "lte":
      return Number(lc) <= Number(rc);
    case "contains":
      if (Array.isArray(left)) return left.includes(rc);
      if (typeof left === "string") return left.includes(String(rc));
      return false;
    case "ncontains":
      if (Array.isArray(left)) return !left.includes(rc);
      if (typeof left === "string") return !left.includes(String(rc));
      return true;
    case "startsWith":
      return String(lc).startsWith(String(rc));
    case "nstartsWith":
      return !String(lc).startsWith(String(rc));
    case "endsWith":
      return String(lc).endsWith(String(rc));
    case "nendsWith":
      return !String(lc).endsWith(String(rc));
    case "regex":
      try {
        return new RegExp(String(rc)).test(String(lc));
      } catch {
        return false;
      }
    case "nregex":
      try {
        return !new RegExp(String(rc)).test(String(lc));
      } catch {
        return true;
      }
    case "isEmpty":
      return isEmpty(left);
    case "isNotEmpty":
      return !isEmpty(left);
    case "exists":
      return left !== undefined && left !== null;
    case "notExists":
      return left === undefined || left === null;
    case "isAfter": {
      const a = new Date(String(lc)).getTime();
      const b = new Date(String(rc)).getTime();
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    }
    case "isBefore": {
      const a = new Date(String(lc)).getTime();
      const b = new Date(String(rc)).getTime();
      return Number.isFinite(a) && Number.isFinite(b) && a < b;
    }
    case "isAfterOrEqual": {
      const a = new Date(String(lc)).getTime();
      const b = new Date(String(rc)).getTime();
      return Number.isFinite(a) && Number.isFinite(b) && a >= b;
    }
    case "isBeforeOrEqual": {
      const a = new Date(String(lc)).getTime();
      const b = new Date(String(rc)).getTime();
      return Number.isFinite(a) && Number.isFinite(b) && a <= b;
    }
    case "isTrue":
      return left === true || String(left).toLowerCase() === "true";
    case "isFalse":
      return left === false || String(left).toLowerCase() === "false";
    case "lenEq":
      return arrLen(left) === Number(rc);
    case "lenNeq":
      return arrLen(left) !== Number(rc);
    case "lenGt":
      return arrLen(left) > Number(rc);
    case "lenGte":
      return arrLen(left) >= Number(rc);
    case "lenLt":
      return arrLen(left) < Number(rc);
    case "lenLte":
      return arrLen(left) <= Number(rc);
    default:
      throw new Error(`if: operador "${op}" não suportado`);
  }
}

function inferDataType(op: string): DataType {
  if (["gt", "gte", "lt", "lte"].includes(op)) return "number";
  if (["isAfter", "isBefore", "isAfterOrEqual", "isBeforeOrEqual"].includes(op)) return "dateTime";
  if (["isTrue", "isFalse", "truthy", "falsy"].includes(op)) return "boolean";
  if (op.startsWith("len")) return "array";
  return "string";
}

export const ifHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = typeof cfg.op === "string" ? cfg.op : "truthy";
  const dataType =
    typeof cfg.dataType === "string" ? (cfg.dataType as DataType) : inferDataType(op);
  const result = evaluate(op, cfg.left, cfg.right, dataType);
  // Espelha o n8n: o IF "passa" o item original adiante (em vez de substituir
  // por metadata só), pra que código downstream consiga referenciar campos
  // tipo `$json.body.x` sem fallback custoso. Metadata vai em `_if`.
  const item =
    context.prev && typeof context.prev === "object"
      ? (context.prev as Record<string, unknown>)
      : {};
  return {
    output: { ...item, _if: { left: cfg.left, op, right: cfg.right, dataType, result } },
    nextLabel: result ? "true" : "false",
  };
};
