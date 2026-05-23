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
import { nodeTypes } from "./types";

const MAX_STEPS = 100;

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
  const targets = new Set(def.edges.map((e) => e.to));
  return def.nodes.find((n) => !targets.has(n.id)) ?? null;
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

    try {
      const result = await handler({ node, context: ctx });
      const finishedAt = new Date();
      ctx.steps[node.id] = result.output;
      if (result.vars) Object.assign(ctx.vars, result.vars);

      await db
        .update(workflowRunSteps)
        .set({
          status: "success",
          output: result.output,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        })
        .where(eqStepId(stepRow!.id));

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
      await db
        .update(workflowRunSteps)
        .set({
          status: "failed",
          error: { message: e.message, stack: e.stack },
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        })
        .where(eqStepId(stepRow!.id));
      throw err;
    }
  }

  return { output: finalOutput, stepsExecuted };
}

function eqStepId(id: string) {
  return eq(workflowRunSteps.id, id);
}
