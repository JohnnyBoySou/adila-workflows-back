/**
 * Tipos do motor de execução de workflows.
 *
 * O `definition` do workflow é um grafo direcionado de nós e arestas.
 * O executor começa pelo nó `start`, percorre arestas seguindo a saída
 * de cada nó e termina quando encontra `end` (ou um nó sem saída).
 *
 * Mantemos o shape em JSONB livre, mas normalizamos pra esse formato
 * antes de executar (`normalizeDefinition`).
 */

/** Identificadores de nó/aresta — strings opacas vindas do editor. */
export type NodeId = string;

/** Tipos de nó suportados pelo MVP do motor. */
export const nodeTypes = [
  "start",
  "end",
  "set_variable",
  "http_request",
  "ai_chat",
  "if",
  "noop",
  "wait",
  "switch",
  "postgres",
  "redis",
] as const;
export type NodeType = (typeof nodeTypes)[number];

export interface WorkflowNode {
  id: NodeId;
  type: NodeType;
  /** Config arbitrária consumida pelo handler do nó. */
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  from: NodeId;
  to: NodeId;
  /**
   * Label da aresta — opcional pra nós lineares; obrigatório pra `if`
   * (esperamos "true" ou "false").
   */
  label?: string;
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/**
 * Contexto disponível pra interpolação `{{ path }}` em qualquer config.
 *
 * - `input`: payload recebido no run (body do webhook, args do disparo)
 * - `vars`: variáveis criadas com `set_variable` dentro do próprio run
 * - `env`: env vars resolvidas (já decriptadas pelo repository)
 * - `steps`: outputs de nós já executados, indexados por `node.id`
 */
export interface ExecutionContext {
  input: Record<string, unknown>;
  vars: Record<string, unknown>;
  env: Record<string, string>;
  steps: Record<NodeId, Record<string, unknown>>;
}

/**
 * Resultado de um handler de nó.
 *
 * - `output`: vira `context.steps[node.id]` e é gravado em workflow_run_steps
 * - `nextLabel`: orienta qual aresta seguir (default: a primeira sem label)
 * - `vars`: merge no `context.vars` (usado pelo set_variable)
 */
export interface NodeResult {
  output: Record<string, unknown>;
  nextLabel?: string;
  vars?: Record<string, unknown>;
}

export interface NodeHandlerArgs {
  node: WorkflowNode;
  context: ExecutionContext;
}

export type NodeHandler = (args: NodeHandlerArgs) => Promise<NodeResult>;
