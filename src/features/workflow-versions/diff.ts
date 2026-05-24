/**
 * Diff entre dois `definition` de workflow.
 *
 * Comparação em nível de id de nó/edge — `position` (layout do canvas) é
 * ignorado, já que não afeta execução. Para nodes em ambos os lados, lista
 * os caminhos de campo (`config.foo.bar`) que mudaram. Edges são comparadas
 * por tupla `(from, to, label)`.
 *
 * Sem libs externas; ~150 linhas puras. Cobrir com unit test no futuro.
 */

type NodeShape = {
  id: string;
  type: string;
  label?: string;
  config: Record<string, unknown>;
};

type EdgeShape = {
  from: string;
  to: string;
  label?: string;
};

export type DefinitionDiff = {
  nodes: {
    added: { id: string; type: string; label?: string }[];
    removed: { id: string; type: string; label?: string }[];
    changed: {
      id: string;
      type: string;
      label?: string;
      fields: string[];
    }[];
  };
  edges: {
    added: number;
    removed: number;
  };
};

function extractNodes(definition: Record<string, unknown>): NodeShape[] {
  const raw = Array.isArray(definition.nodes) ? definition.nodes : [];
  const out: NodeShape[] = [];
  for (const n of raw) {
    if (!n || typeof n !== "object") continue;
    const node = n as Record<string, unknown>;
    const id = node.id;
    const type = node.type;
    if (typeof id !== "string" || typeof type !== "string") continue;
    // O label pode vir solto no nó ou dentro de `data` (formato React Flow).
    const data = (node.data && typeof node.data === "object" ? node.data : {}) as Record<
      string,
      unknown
    >;
    const label =
      typeof node.label === "string"
        ? node.label
        : typeof data.label === "string"
          ? data.label
          : undefined;
    out.push({
      id,
      type,
      label,
      config:
        node.config && typeof node.config === "object"
          ? (node.config as Record<string, unknown>)
          : {},
    });
  }
  return out;
}

function extractEdges(definition: Record<string, unknown>): EdgeShape[] {
  const raw = Array.isArray(definition.edges) ? definition.edges : [];
  const out: EdgeShape[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const edge = e as Record<string, unknown>;
    // Aceita `from/to` (formato engine) e `source/target` (formato React Flow).
    const from = typeof edge.from === "string" ? edge.from : (edge.source as string | undefined);
    const to = typeof edge.to === "string" ? edge.to : (edge.target as string | undefined);
    if (typeof from !== "string" || typeof to !== "string") continue;
    out.push({
      from,
      to,
      label: typeof edge.label === "string" ? edge.label : undefined,
    });
  }
  return out;
}

/**
 * Lista os caminhos onde `a` e `b` diferem, descendo recursivamente em
 * objetos. Arrays e primitivos são comparados por igualdade estrutural via
 * JSON.stringify ordenado — bom o suficiente pra detectar mudanças de
 * valor sem precisar de deep-equal robusto.
 */
function diffFields(a: unknown, b: unknown, prefix = ""): string[] {
  if (a === b) return [];
  const aIsObj = a && typeof a === "object" && !Array.isArray(a);
  const bIsObj = b && typeof b === "object" && !Array.isArray(b);
  if (!aIsObj || !bIsObj) {
    if (stableStringify(a) === stableStringify(b)) return [];
    return [prefix || "(root)"];
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  const paths: string[] = [];
  for (const k of keys) {
    const next = prefix ? `${prefix}.${k}` : k;
    paths.push(...diffFields(aObj[k], bObj[k], next));
  }
  return paths;
}

function stableStringify(val: unknown): string {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val as object).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((val as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

export function diffDefinitions(
  fromDef: Record<string, unknown>,
  toDef: Record<string, unknown>,
): DefinitionDiff {
  const fromNodes = new Map(extractNodes(fromDef).map((n) => [n.id, n]));
  const toNodes = new Map(extractNodes(toDef).map((n) => [n.id, n]));

  const added: DefinitionDiff["nodes"]["added"] = [];
  const removed: DefinitionDiff["nodes"]["removed"] = [];
  const changed: DefinitionDiff["nodes"]["changed"] = [];

  for (const [id, node] of toNodes) {
    if (!fromNodes.has(id)) {
      added.push({ id, type: node.type, label: node.label });
    }
  }
  for (const [id, node] of fromNodes) {
    if (!toNodes.has(id)) {
      removed.push({ id, type: node.type, label: node.label });
      continue;
    }
    const toNode = toNodes.get(id)!;
    const fields: string[] = [];
    if (node.type !== toNode.type) fields.push("type");
    fields.push(...diffFields(node.config, toNode.config, "config"));
    if (fields.length > 0) {
      changed.push({ id, type: toNode.type, label: toNode.label, fields });
    }
  }

  // Edges: chaves estáveis baseadas em (from, to, label).
  const edgeKey = (e: EdgeShape) => `${e.from}→${e.to}|${e.label ?? ""}`;
  const fromEdgeKeys = new Set(extractEdges(fromDef).map(edgeKey));
  const toEdgeKeys = new Set(extractEdges(toDef).map(edgeKey));

  let edgesAdded = 0;
  let edgesRemoved = 0;
  for (const k of toEdgeKeys) if (!fromEdgeKeys.has(k)) edgesAdded++;
  for (const k of fromEdgeKeys) if (!toEdgeKeys.has(k)) edgesRemoved++;

  return {
    nodes: { added, removed, changed },
    edges: { added: edgesAdded, removed: edgesRemoved },
  };
}
