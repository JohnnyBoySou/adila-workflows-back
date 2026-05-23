/**
 * Executor sequencial de workflows.
 *
 * Lê o `definition` (já normalizado), começa pelo nó `start`, executa
 * o handler de cada nó, escolhe a próxima aresta e segue até `end` ou
 * um nó sem saída. Grava uma linha em `workflow_run_steps` por nó visitado.
 *
 * Limites:
 *   - MAX_STEPS protege contra loops (não temos ciclos válidos no MVP)
 *   - falha em um nó interrompe o run inteiro
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { workflowRunSteps } from "../../db/schema";
import { nodeHandlers } from "./nodes";
import type {
  ExecutionContext,
  NodeId,
  NodeType,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "./types";

/** Tipo do callback de sub-workflow — espelha o de `ExecutionContext`. */
type SubWorkflowRunner = NonNullable<ExecutionContext["subWorkflowRunner"]>;
import { nodeTypes, visualNodeTypes } from "./types";

// Suporta loops controlados (split_in_batches). 1000 cobre arrays típicos;
// proteção real contra loop runaway fica no próprio handler de batches.
const MAX_STEPS = 1000;

/**
 * Erro lançado quando um cancelamento cooperativo é detectado entre nós.
 * O worker trata diferente de uma falha normal — grava status='cancelled'.
 */
export class CancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "CancelledError";
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
  /**
   * Polling cooperativo de cancelamento. Chamado antes de cada nó —
   * se devolve true, o executor lança `CancelledError`.
   */
  checkCancelled?: () => Promise<boolean>;
  /**
   * Notificação de cada transição de step. Worker usa pra publicar em
   * Redis pub/sub e a API encaminha por SSE. Best-effort — erros aqui
   * não interrompem a execução.
   */
  onStepEvent?: (event: StepEvent) => void | Promise<void>;
  /**
   * Permite ao nó `execute_workflow` invocar sub-runs. Injetado pelo
   * worker (orquestrador real); ausente em testes do executor puro.
   */
  subWorkflowRunner?: SubWorkflowRunner;
}

export interface RunExecutionResult {
  output: Record<string, unknown>;
  stepsExecuted: number;
}

/**
 * Normaliza o `definition` cru (JSONB) pra `{ nodes, edges }`.
 *
 * Aceita também o legado `{}` — devolve grafo vazio e o executor termina
 * sem fazer nada (success com output vazio).
 */
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

/** Acha o nó de start; aceita explícito (type=start) ou inferido (sem aresta entrando). */
function findStart(def: WorkflowDefinition): WorkflowNode | null {
  const explicit = def.nodes.find((n) => n.type === "start");
  if (explicit) return explicit;
  // Visuais (sticky_note, container) não devem ser elegíveis como start —
  // eles vivem soltos no canvas sem edges de entrada.
  const targets = new Set(def.edges.map((e) => e.to));
  return def.nodes.find((n) => !visualNodeTypes.has(n.type) && !targets.has(n.id)) ?? null;
}

/** Escolhe a próxima aresta a partir de `from`, opcionalmente filtrando por label. */
function pickNextEdge(
  edges: WorkflowEdge[],
  from: NodeId,
  label: string | undefined,
): WorkflowEdge | null {
  const outgoing = edges.filter((e) => e.from === from);
  if (outgoing.length === 0) return null;
  if (label) {
    const labeled = outgoing.find((e) => e.label === label);
    if (labeled) return labeled;
  }
  // Default: primeira aresta sem label, ou a primeira no geral.
  const unlabeled = outgoing.find((e) => !e.label);
  return unlabeled ?? outgoing[0]!;
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
  };

  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  let current: WorkflowNode | undefined = start;
  let stepsExecuted = 0;
  let finalOutput: Record<string, unknown> = {};

  while (current) {
    if (stepsExecuted >= MAX_STEPS) {
      throw new Error(`limite de ${MAX_STEPS} nós atingido — possível loop`);
    }
    // Checagem cooperativa antes de pré-gravar o próximo step.
    if (args.checkCancelled && (await args.checkCancelled())) {
      throw new CancelledError();
    }
    stepsExecuted++;

    const startedAt = new Date();
    const node = current;
    const handler = nodeHandlers[node.type];
    if (!handler) {
      throw new Error(`nó "${node.id}": tipo "${node.type}" sem handler`);
    }

    // Pré-grava o step como running, pra ficar visível mesmo se travar.
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
      const result = await handler({ node, context: ctx });
      const finishedAt = new Date();
      ctx.steps[node.id] = result.output;
      if (result.vars) Object.assign(ctx.vars, result.vars);

      const durationMs = finishedAt.getTime() - startedAt.getTime();
      await db
        .update(workflowRunSteps)
        .set({
          status: "success",
          output: result.output,
          finishedAt,
          durationMs,
        })
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

      // Nó end → encerra o run com o output dele.
      if (node.type === "end") {
        finalOutput = result.output;
        break;
      }

      const nextEdge = pickNextEdge(def.edges, node.id, result.nextLabel);
      if (!nextEdge) {
        // Sem saída — termina com o output do último nó.
        finalOutput = result.output;
        break;
      }
      const next = byId.get(nextEdge.to);
      if (!next) {
        throw new Error(`aresta aponta pra nó inexistente: ${nextEdge.to}`);
      }
      current = next;
    } catch (err) {
      const e = err as Error;
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const errorPayload = { message: e.message, stack: e.stack };
      await db
        .update(workflowRunSteps)
        .set({
          status: "failed",
          error: errorPayload,
          finishedAt,
          durationMs,
        })
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
