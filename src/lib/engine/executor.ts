/**
 * Executor com worklist BFS — suporta fork/join.
 *
 * Modelo: cada nó tem in-degree de arestas "live" e um contador de "live done".
 * Quando um nó conclui, ele propaga pelas arestas de saída — todas se o nó for
 * não-condicional (fork), só a aresta do `nextLabel` se for condicional
 * (if/switch/split_in_batches). As demais viram "dead" e propagam um skip
 * em cascata pela subárvore.
 *
 * Merge: um nó com múltiplas incoming live edges naturalmente espera todas
 * (in-degree decrementa só quando cada predecessor termina). Quando todas
 * chegaram, ele é enfileirado uma única vez.
 *
 * Loops (split_in_batches): back-edges são detectadas no boot via reachability
 * forward (se o destino consegue chegar de volta no source, a aresta é back).
 * Back-edges não contam pra in-degree inicial e re-enfileiram o target a cada
 * disparo — o nó pode ser re-executado quantas vezes precisar (MAX_STEPS
 * continua sendo o teto global).
 *
 * Limites:
 *   - MAX_STEPS protege contra runaway (loops sem condição de parada)
 *   - falha em qualquer nó interrompe o run (todas as branches em curso)
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { workflowRunSteps } from "../../db/schema";
import { nodeHandlers } from "./nodes";
import {
  nodeTypes,
  TRIGGER_NODE_TYPES,
  visualNodeTypes,
  type ExecutionContext,
  type NodeId,
  type NodeType,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "./types";

type SubWorkflowRunner = NonNullable<ExecutionContext["subWorkflowRunner"]>;
type ConnectionResolver = NonNullable<ExecutionContext["resolveConnection"]>;

const MAX_STEPS = 1000;

/** Erro lançado em cancelamento cooperativo entre nós. */
export class CancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Sinaliza ao worker que o job é retentável pelo BullMQ. Use para falhas
 * transientes (timeout de rede, 5xx, Redis offline); erros de validação
 * normais não devem ser retentados.
 */
export class RetryableError extends Error {
  readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "RetryableError";
    this.cause = options?.cause;
  }
}

export interface StepEvent {
  type: "step-start" | "step-success" | "step-failed";
  index: number;
  nodeId: string;
  nodeType: string;
  status: "running" | "success" | "failed";
  output?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  durationMs?: number | null;
}

export interface RunExecutionInput {
  runId: string;
  definition: unknown;
  input: Record<string, unknown>;
  env: Record<string, string>;
  pinnedData?: Record<string, Record<string, unknown>>;
  stopAtNodeId?: string;
  checkCancelled?: () => Promise<boolean>;
  onStepEvent?: (event: StepEvent) => void | Promise<void>;
  subWorkflowRunner?: SubWorkflowRunner;
  resolveConnection?: ConnectionResolver;
}

export interface RunExecutionResult {
  output: Record<string, unknown>;
  stepsExecuted: number;
}

export function normalizeDefinition(raw: unknown): WorkflowDefinition {
  if (!raw || typeof raw !== "object") return { nodes: [], edges: [] };
  const obj = raw as Record<string, unknown>;
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  if (Array.isArray(obj.nodes)) {
    for (const n of obj.nodes) {
      if (!n || typeof n !== "object") continue;
      const node = n as Record<string, unknown>;
      const id = node.id;
      const type = node.type;
      if (typeof id !== "string" || typeof type !== "string") continue;
      if (!(nodeTypes as readonly string[]).includes(type)) continue;
      nodes.push({
        id,
        type: type as NodeType,
        config:
          node.config && typeof node.config === "object"
            ? (node.config as Record<string, unknown>)
            : {},
      });
    }
  }
  if (Array.isArray(obj.edges)) {
    for (const e of obj.edges) {
      if (!e || typeof e !== "object") continue;
      const edge = e as Record<string, unknown>;
      if (typeof edge.from !== "string" || typeof edge.to !== "string") continue;
      edges.push({
        from: edge.from,
        to: edge.to,
        label: typeof edge.label === "string" ? edge.label : undefined,
      });
    }
  }
  return { nodes, edges };
}

/** Acha o nó de start; aceita explícito (qualquer trigger type) ou inferido. */
function findStart(def: WorkflowDefinition): WorkflowNode | null {
  const explicit = def.nodes.find((n) => TRIGGER_NODE_TYPES.has(n.type));
  if (explicit) return explicit;
  const targets = new Set(def.edges.map((e) => e.to));
  return def.nodes.find((n) => !visualNodeTypes.has(n.type) && !targets.has(n.id)) ?? null;
}

/**
 * Escolhe a aresta correspondente a `label`. Quando o handler devolve
 * nextLabel, queremos a aresta com aquele rótulo; se não existir, caímos
 * pra primeira sem label, e em último caso a primeira.
 */
function pickLiveEdge(
  outgoing: WorkflowEdge[],
  label: string | undefined,
): WorkflowEdge | null {
  if (outgoing.length === 0) return null;
  if (label) {
    const labeled = outgoing.find((e) => e.label === label);
    if (labeled) return labeled;
  }
  const unlabeled = outgoing.find((e) => !e.label);
  return unlabeled ?? outgoing[0]!;
}

/**
 * Identifica back-edges (loops). Uma aresta u→v é back-edge se existe
 * caminho v→…→u via arestas forward — ou seja, v é ancestral de u no DAG
 * subjacente. Back-edges são tratadas como re-entradas: não contam pra
 * in-degree inicial e re-disparam o target ao serem percorridas.
 */
function findBackEdges(def: WorkflowDefinition): Set<WorkflowEdge> {
  const back = new Set<WorkflowEdge>();
  const adj = new Map<NodeId, WorkflowEdge[]>();
  for (const e of def.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e);
  }
  // Pra cada aresta u→v: BFS a partir de v; se atingir u, é back.
  for (const edge of def.edges) {
    if (reachable(adj, edge.to, edge.from)) back.add(edge);
  }
  return back;
}

function reachable(
  adj: Map<NodeId, WorkflowEdge[]>,
  from: NodeId,
  target: NodeId,
): boolean {
  if (from === target) return true;
  const seen = new Set<NodeId>([from]);
  const queue: NodeId[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    const out = adj.get(cur);
    if (!out) continue;
    for (const e of out) {
      if (e.to === target) return true;
      if (!seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return false;
}

type NodeStatus = "pending" | "ready" | "running" | "done" | "skipped" | "failed";

interface NodeMeta {
  node: WorkflowNode;
  outgoing: WorkflowEdge[];
  /**
   * Apenas forward edges (back-edges excluídas). Usado pra in-degree inicial
   * e propagação de skip — back-edges são tratadas à parte como re-entradas.
   */
  forwardIncoming: WorkflowEdge[];
  remaining: number; // forward incoming live edges ainda não resolvidas
  liveDoneCount: number; // forward incoming live edges já cumpridas
  status: NodeStatus;
}

export async function executeRun(args: RunExecutionInput): Promise<RunExecutionResult> {
  const def = normalizeDefinition(args.definition);
  if (def.nodes.length === 0) {
    return { output: {}, stepsExecuted: 0 };
  }

  const start = findStart(def);
  if (!start) throw new Error("definition: nenhum nó de start encontrado");

  const ctx: ExecutionContext = {
    input: args.input ?? {},
    vars: {},
    env: args.env ?? {},
    steps: {},
    loopState: {},
    subWorkflowRunner: args.subWorkflowRunner,
    resolveConnection: args.resolveConnection,
  };

  const backEdges = findBackEdges(def);
  /**
   * Nós cíclicos (capazes de chegar em si mesmos). Skip a partir dessas
   * fontes é suprimido: a próxima iteração pode disparar a aresta live, e
   * marcar o destino como skipped agora condenaria nós que ainda vão rodar.
   * Padrão: split_in_batches alternando "loop" e "done" — o "done" precisa
   * sobreviver às iterações em que "loop" foi escolhido.
   */
  const adjForCyclic = new Map<NodeId, WorkflowEdge[]>();
  for (const e of def.edges) {
    if (!adjForCyclic.has(e.from)) adjForCyclic.set(e.from, []);
    adjForCyclic.get(e.from)!.push(e);
  }
  const cyclicNodes = new Set<NodeId>();
  for (const n of def.nodes) {
    if (reachable(adjForCyclic, n.id, n.id)) cyclicNodes.add(n.id);
  }
  const meta = new Map<NodeId, NodeMeta>();
  for (const n of def.nodes) {
    if (visualNodeTypes.has(n.type)) continue;
    meta.set(n.id, {
      node: n,
      outgoing: def.edges.filter((e) => e.from === n.id),
      forwardIncoming: def.edges.filter((e) => e.to === n.id && !backEdges.has(e)),
      remaining: 0,
      liveDoneCount: 0,
      status: "pending",
    });
  }
  for (const m of meta.values()) {
    m.remaining = m.forwardIncoming.length;
  }

  // Start sempre roda primeiro; seu in-degree forward esperado é 0.
  const startMeta = meta.get(start.id);
  if (!startMeta) throw new Error("definition: start está num tipo visual?");
  startMeta.status = "ready";
  const ready: WorkflowNode[] = [start];

  const pinnedData = args.pinnedData ?? {};
  let stepsExecuted = 0;
  let finalOutput: Record<string, unknown> = {};
  let terminated = false;
  let lastOutput: Record<string, unknown> = {};

  /**
   * Skip propaga: decrementa `remaining` do target; se zerar e nenhum live
   * predecessor entregou (liveDoneCount=0), o target também é skipped e
   * cascateia. Se zerar e tiver pelo menos um live done, enfileira o target.
   */
  function propagateDead(toId: NodeId): void {
    const m = meta.get(toId);
    if (!m) return;
    if (m.status === "skipped" || m.status === "done" || m.status === "failed") return;
    m.remaining = Math.max(0, m.remaining - 1);
    if (m.remaining > 0) return;
    if (m.liveDoneCount > 0) {
      if (m.status === "pending") {
        m.status = "ready";
        ready.push(m.node);
      }
      return;
    }
    // Sem nenhum live predecessor — esse nó vira skipped também.
    m.status = "skipped";
    for (const e of m.outgoing) {
      if (backEdges.has(e)) continue;
      propagateDead(e.to);
    }
  }

  while (ready.length > 0 && !terminated) {
    if (stepsExecuted >= MAX_STEPS) {
      throw new Error(`limite de ${MAX_STEPS} nós atingido — possível loop`);
    }
    if (args.checkCancelled && (await args.checkCancelled())) {
      throw new CancelledError();
    }

    const node = ready.shift()!;
    const m = meta.get(node.id);
    if (!m || m.status !== "ready") continue; // foi resetado por outro caminho
    m.status = "running";

    stepsExecuted++;
    const startedAt = new Date();
    const handler = nodeHandlers[node.type];
    if (!handler) {
      throw new Error(`nó "${node.id}": tipo "${node.type}" sem handler`);
    }

    const [stepRow] = await db
      .insert(workflowRunSteps)
      .values({
        runId: args.runId,
        index: stepsExecuted,
        nodeId: node.id,
        nodeType: node.type,
        status: "running",
        startedAt,
      })
      .returning({ id: workflowRunSteps.id });

    await emitStep(args.onStepEvent, {
      type: "step-start",
      index: stepsExecuted,
      nodeId: node.id,
      nodeType: node.type,
      status: "running",
    });

    try {
      const pinned = pinnedData[node.id];
      const result = pinned ? { output: pinned } : await handler({ node, context: ctx });
      const finishedAt = new Date();
      ctx.steps[node.id] = result.output;
      lastOutput = result.output;
      if ("vars" in result && result.vars) Object.assign(ctx.vars, result.vars);

      const durationMs = finishedAt.getTime() - startedAt.getTime();
      await db
        .update(workflowRunSteps)
        .set({ status: "success", output: result.output, finishedAt, durationMs })
        .where(eqStepId(stepRow!.id));

      await emitStep(args.onStepEvent, {
        type: "step-success",
        index: stepsExecuted,
        nodeId: node.id,
        nodeType: node.type,
        status: "success",
        output: result.output,
        durationMs,
      });

      // Terminação: end ou stopAtNodeId encerram tudo.
      if (node.type === "end" || args.stopAtNodeId === node.id) {
        finalOutput = result.output;
        terminated = true;
        break;
      }

      m.status = "done";

      const nextLabel = "nextLabel" in result ? result.nextLabel : undefined;
      let liveEdges: WorkflowEdge[];
      let deadEdges: WorkflowEdge[];
      if (nextLabel !== undefined) {
        const chosen = pickLiveEdge(m.outgoing, nextLabel);
        liveEdges = chosen ? [chosen] : [];
        deadEdges = m.outgoing.filter((e) => e !== chosen);
      } else {
        liveEdges = m.outgoing;
        deadEdges = [];
      }

      for (const edge of liveEdges) {
        const target = meta.get(edge.to);
        if (!target) continue;
        if (backEdges.has(edge)) {
          // Re-entrada: reseta o estado do target e re-enfileira. In-degree
          // forward não muda — só as forward edges contam pra ele já estar
          // "estavelmente" pronto na primeira passagem.
          target.status = "ready";
          target.liveDoneCount = 1;
          target.remaining = 0;
          ready.push(target.node);
          continue;
        }
        target.liveDoneCount++;
        target.remaining = Math.max(0, target.remaining - 1);
        if (target.remaining === 0 && target.status === "pending") {
          target.status = "ready";
          ready.push(target.node);
        }
      }
      for (const edge of deadEdges) {
        if (backEdges.has(edge)) continue; // back morta é só não-disparo
        if (cyclicNodes.has(node.id)) continue; // fonte cíclica pode revisitar
        propagateDead(edge.to);
      }
    } catch (err) {
      const e = err as Error;
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const errorPayload = { message: e.message, stack: e.stack };
      m.status = "failed";
      await db
        .update(workflowRunSteps)
        .set({ status: "failed", error: errorPayload, finishedAt, durationMs })
        .where(eqStepId(stepRow!.id));
      await emitStep(args.onStepEvent, {
        type: "step-failed",
        index: stepsExecuted,
        nodeId: node.id,
        nodeType: node.type,
        status: "failed",
        error: errorPayload,
        durationMs,
      });
      throw err;
    }
  }

  if (!terminated) {
    // Sem end explícito — devolve o output do último nó concluído.
    finalOutput = lastOutput;
  }

  return { output: finalOutput, stepsExecuted };
}

function eqStepId(id: string) {
  return eq(workflowRunSteps.id, id);
}

async function emitStep(cb: RunExecutionInput["onStepEvent"], event: StepEvent): Promise<void> {
  if (!cb) return;
  try {
    await cb(event);
  } catch {
    // Best-effort: falha de notificação não derruba execução.
  }
}
