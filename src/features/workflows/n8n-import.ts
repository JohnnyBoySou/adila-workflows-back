/**
 * Importer de workflows do n8n.
 *
 * Recebe o JSON exportado pelo n8n (estrutura `{ name, nodes[], connections{} }`)
 * e produz um `definition` no formato que o nosso editor/executor consomem,
 * preservando o JSON original em `definition.source` pra round-trip lossless.
 *
 * Mapeamento de tipos:
 *  - Tipos suportados nativamente viram o equivalente da nossa enum
 *    (`start`, `set_variable`, `http_request`, `if`, `ai_chat`).
 *  - `stickyNote` é descartado (visual puro).
 *  - Qualquer outro tipo entra como `unsupported`, mantendo o type original
 *    em `config.originalType` e os parâmetros em `config.original`. Esses nós
 *    não vão executar até ganharem handler — mas a estrutura está lá.
 *
 * Conexões: n8n indexa por *name* do nó; convertemos pra edges (`from`/`to`)
 * usando o `id` (uuid) que o n8n já gera por nó.
 */
import type { WorkflowDefinition } from "../../lib/engine/types";

// ── shapes parciais do JSON do n8n (validamos só o que usamos) ─────────
interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  webhookId?: string;
  credentials?: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
}

interface N8nConnectionTarget {
  node: string;
  type?: string;
  index?: number;
}

interface N8nConnections {
  [sourceName: string]: {
    [outputKind: string]: Array<Array<N8nConnectionTarget>>;
  };
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections?: N8nConnections;
  settings?: Record<string, unknown>;
  active?: boolean;
}

// ── tabela de mapeamento ───────────────────────────────────────────────
type MappedType =
  | "start"
  | "set_variable"
  | "http_request"
  | "if"
  | "ai_chat"
  | "noop"
  | "wait"
  | "switch"
  | "postgres"
  | "redis";

const TYPE_MAP: Record<string, MappedType> = {
  "n8n-nodes-base.webhook": "start",
  "@n8n/n8n-nodes-langchain.chatTrigger": "start",
  "n8n-nodes-base.set": "set_variable",
  "n8n-nodes-base.httpRequest": "http_request",
  "n8n-nodes-base.httpRequestTool": "http_request",
  "n8n-nodes-base.if": "if",
  "n8n-nodes-base.filter": "if",
  "@n8n/n8n-nodes-langchain.agent": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatOpenAi": "ai_chat",
  "n8n-nodes-base.noOp": "noop",
  "n8n-nodes-base.wait": "wait",
  "n8n-nodes-base.switch": "switch",
  "n8n-nodes-base.postgres": "postgres",
  "n8n-nodes-base.redis": "redis",
};

// Tipos puramente visuais — descartados.
const SKIPPED_TYPES = new Set(["n8n-nodes-base.stickyNote"]);

export interface ImportSummary {
  total: number;
  mapped: number;
  unsupported: number;
  skipped: number;
  unsupportedTypes: string[];
}

export interface ImportResult {
  definition: WorkflowDefinition & {
    source: { format: "n8n"; raw: N8nWorkflow };
    importMeta: ImportSummary;
  };
  name: string;
  summary: ImportSummary;
}

// ── conversor ──────────────────────────────────────────────────────────
export function importN8nWorkflow(raw: unknown): ImportResult | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid_payload" };
  const wf = raw as Partial<N8nWorkflow>;
  if (typeof wf.name !== "string" || !Array.isArray(wf.nodes)) {
    return { error: "invalid_n8n_workflow" };
  }

  const summary: ImportSummary = {
    total: wf.nodes.length,
    mapped: 0,
    unsupported: 0,
    skipped: 0,
    unsupportedTypes: [],
  };
  const unsupportedSet = new Set<string>();

  // Constrói name→id pra resolver conexões.
  const nameToId = new Map<string, string>();
  for (const n of wf.nodes) {
    if (n && typeof n.name === "string" && typeof n.id === "string") {
      nameToId.set(n.name, n.id);
    }
  }

  const nodes: WorkflowDefinition["nodes"] = [];
  for (const n of wf.nodes) {
    if (!n || typeof n.id !== "string" || typeof n.type !== "string") continue;
    if (SKIPPED_TYPES.has(n.type)) {
      summary.skipped++;
      continue;
    }
    const mapped = TYPE_MAP[n.type];
    if (mapped) {
      nodes.push({
        id: n.id,
        type: mapped,
        config: {
          n8nName: n.name,
          originalType: n.type,
          parameters: n.parameters ?? {},
          ...(n.position && { position: n.position }),
          ...(n.disabled && { disabled: true }),
        },
      });
      summary.mapped++;
    } else {
      nodes.push({
        // type fora da nossa enum — o executor ignora até ganhar handler,
        // mas o editor preserva.
        id: n.id,
        type: "unsupported" as never,
        config: {
          n8nName: n.name,
          originalType: n.type,
          parameters: n.parameters ?? {},
          ...(n.position && { position: n.position }),
        },
      });
      summary.unsupported++;
      unsupportedSet.add(n.type);
    }
  }

  // Conexões → edges. n8n estrutura: connections[sourceName][outputKind][outputIndex] = [targets].
  const edges: WorkflowDefinition["edges"] = [];
  const connections = wf.connections ?? {};
  for (const [sourceName, outputs] of Object.entries(connections)) {
    const fromId = nameToId.get(sourceName);
    if (!fromId) continue;
    for (const [outputKind, branches] of Object.entries(outputs)) {
      if (!Array.isArray(branches)) continue;
      branches.forEach((branch, branchIdx) => {
        if (!Array.isArray(branch)) return;
        for (const target of branch) {
          if (!target || typeof target.node !== "string") continue;
          const toId = nameToId.get(target.node);
          if (!toId) continue;
          // Label: pra branches de `if`/`switch`, identifica a saída.
          // outputKind=main é o caso comum (linear); branches[0/1] em `if` viram true/false.
          let label: string | undefined;
          if (outputKind !== "main") label = outputKind;
          else if (branches.length > 1) label = String(branchIdx);
          edges.push({ from: fromId, to: toId, label });
        }
      });
    }
  }

  // oxlint-disable-next-line unicorn/no-array-sort
  summary.unsupportedTypes = [...unsupportedSet].sort();

  return {
    name: wf.name,
    summary,
    definition: {
      nodes,
      edges,
      source: { format: "n8n", raw: wf as N8nWorkflow },
      importMeta: summary,
    },
  };
}
