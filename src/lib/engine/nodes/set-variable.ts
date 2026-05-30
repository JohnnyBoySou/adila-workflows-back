import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Define variável(eis) no `context.vars` (mutável durante o run).
 *
 * Dois modos suportados:
 *
 *   single: { name: string, value: any (templatable) }
 *   multi:  { variables: { foo: any, bar: any, ... } }   ← todos templatáveis
 *
 * O `multi` é o formato usado pelo importer de n8n (que traz N assignments).
 *
 * Coerção de tipo opcional (`_types`): o importer pode anexar um mapa
 *   `{ foo: "boolean", bar: "number", baz: "string" }` indicando o tipo desejado
 *   após o render. Útil quando o template resolve "true" (string) mas o
 *   downstream `if equals true (boolean)` precisa do tipo correto.
 */
function coerce(value: unknown, type: string): unknown {
  switch (type) {
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (v === "true") return true;
        if (v === "false") return false;
      }
      return Boolean(value);
    }
    case "number": {
      if (typeof value === "number") return value;
      const n = Number(value);
      return Number.isFinite(n) ? n : value;
    }
    case "string":
      return value === null || value === undefined ? "" : String(value);
    case "object":
    case "array":
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    default:
      return value;
  }
}

// Nomes com pontos viram nested: setDeep(out, "config.bearerToken", "123")
// → out.config.bearerToken = "123". Espelha o comportamento do n8n (`a.b.c`).
function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export const setVariableHandler: NodeHandler = async ({ node, context }) => {
  if (node.config.variables && typeof node.config.variables === "object") {
    const rendered = renderTemplate(node.config.variables, context) as Record<string, unknown>;
    const types = (node.config._types ?? null) as Record<string, string> | null;
    const final: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rendered)) {
      const t = types?.[k];
      const coerced = t ? coerce(v, t) : v;
      // Mantém a chave flat (compatibilidade com nós downstream que usam
      // `vars["config.bearerToken"]`) E também espelha como nested,
      // pra templates `{{ prev.config.bearerToken }}` resolverem.
      final[k] = coerced;
      if (k.includes(".")) setDeep(final, k, coerced);
    }
    return { vars: final, output: final };
  }

  const name = node.config.name;
  if (typeof name !== "string" || !name) {
    throw new Error("set_variable: informe `name` ou `variables`");
  }
  const value = renderTemplate(node.config.value, context);
  return { vars: { [name]: value }, output: { name, value } };
};
