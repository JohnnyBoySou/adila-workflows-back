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
  "webhook_trigger",
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
  "code",
  "split_in_batches",
  "embeddings",
  "vector_store",
  "chat_memory",
  "document_loader",
  "sticky_note",
  "container",
  "respond_to_webhook",
  "date_time",
  "crypto",
  "item_lists",
  "aggregate",
  "execute_workflow",
] as const;
export type NodeType = (typeof nodeTypes)[number];

/**
 * Tipos puramente visuais — não executam, servem só pra editor (anotações,
 * agrupamentos no estilo Figma frame). O executor pula esses ao escolher
 * start e qualquer aresta apontando pra eles é tratada como no-op.
 */
export const visualNodeTypes = new Set<NodeType>(["sticky_note", "container"]);

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
  /**
   * Estado opaco compartilhado entre handlers iterativos (split_in_batches).
   * Não usar fora deles — não é parte do template engine.
   */
  loopState?: Record<NodeId, { cursor: number; items: unknown[] }>;
  /**
   * Callback injetado pelo worker pra `execute_workflow` invocar sub-runs.
   * Não é template-visível — handlers chamam direto. Ausente fora do worker
   * (ex: testes unitários do executor); o handler falha cedo nesse caso.
   */
  subWorkflowRunner?: (args: {
    workflowId: string;
    input: Record<string, unknown>;
    environmentId: string | null;
    timeoutMs: number;
  }) => Promise<{
    runId: string;
    status: "success" | "failed" | "cancelled" | "timeout";
    output?: Record<string, unknown>;
  }>;
  /**
   * Resolve uma connection (DB) por referência. `ref` pode ser um UUID
   * (legado, pinned na linha específica) ou um nome lógico (`"db_main"`,
   * resolvido pela closure do worker contra `(workflowId, name,
   * environmentId)` com fallback default). Já vem decifrada — uso só
   * dentro do worker. Os handlers `postgres`/`redis` chamam isto pra
   * obter a URL sem nunca tocar em material cifrado.
   *
   * Ausente em testes unitários do executor; nesses contextos pode-se
   * stubar este callback diretamente.
   */
  resolveConnection?: (
    ref: string,
  ) => Promise<{ connectionString: string; kind: "postgres" | "redis" } | null>;
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
