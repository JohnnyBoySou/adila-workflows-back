import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { workflowRuns, workflowRunSteps, workflows } from "../src/db/schema";
import {
  CancelledError,
  executeRun,
  normalizeDefinition,
  type RunExecutionInput,
} from "../src/lib/engine/executor";

/**
 * Testes de semântica de grafo do executor. Precisam de DB real (testcontainers)
 * porque cada step é gravado em `workflow_run_steps` com FK pra `workflow_runs`.
 *
 * Cada teste cria seu próprio run row e invoca `executeRun` com uma definition
 * inline, exercitando o worklist BFS: linear, fork/join, skip de branch morta,
 * o fan-in pós-IF (regressão), loop com back-edge, runaway, cancelamento,
 * stopAtNodeId, falha de nó, pinnedData e casos degenerados.
 */

let orgId: string;
let userId: string;
let workflowId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Executor Tester",
    email: `exec-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Executor Org",
    slug: `exec-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });
  const [wf] = await db
    .insert(workflows)
    .values({ organizationId: orgId, name: "exec-fixture", createdBy: userId })
    .returning({ id: workflows.id });
  workflowId = wf!.id;
});

/** Cria uma linha de run e devolve seu id (FK exigida pelos steps). */
async function newRunId(): Promise<string> {
  const [run] = await db
    .insert(workflowRuns)
    .values({ organizationId: orgId, workflowId, status: "running" })
    .returning({ id: workflowRuns.id });
  return run!.id;
}

/** Executa uma definition inline num run fresco. */
async function exec(
  definition: unknown,
  overrides: Partial<Omit<RunExecutionInput, "runId" | "definition">> = {},
) {
  const runId = await newRunId();
  const result = await executeRun({
    runId,
    definition,
    input: overrides.input ?? {},
    env: overrides.env ?? {},
    ...overrides,
  });
  return { runId, result };
}

/** Lê os steps gravados de um run, ordenados por index. */
async function stepsOf(runId: string) {
  return db
    .select()
    .from(workflowRunSteps)
    .where(eq(workflowRunSteps.runId, runId))
    .orderBy(workflowRunSteps.index);
}

describe("normalizeDefinition", () => {
  test("objeto inválido vira grafo vazio", () => {
    expect(normalizeDefinition(null)).toEqual({ nodes: [], edges: [] });
    expect(normalizeDefinition("nope")).toEqual({ nodes: [], edges: [] });
    expect(normalizeDefinition(42)).toEqual({ nodes: [], edges: [] });
  });

  test("aplica alias legado http → http_request", () => {
    const def = normalizeDefinition({
      nodes: [{ id: "a", type: "http", config: {} }],
      edges: [],
    });
    expect(def.nodes).toHaveLength(1);
    expect(def.nodes[0]!.type).toBe("http_request");
  });

  test("descarta nós de tipo desconhecido", () => {
    const def = normalizeDefinition({
      nodes: [
        { id: "a", type: "start", config: {} },
        { id: "b", type: "tipo_inexistente", config: {} },
      ],
      edges: [],
    });
    expect(def.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  test("descarta nós sem id ou type e edges malformadas", () => {
    const def = normalizeDefinition({
      nodes: [
        { id: "a", type: "start", config: {} },
        { type: "noop", config: {} },
        { id: "c" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a" },
        { to: "b" },
      ],
    });
    expect(def.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(def.edges).toEqual([{ from: "a", to: "b", label: undefined }]);
  });

  test("config ausente vira objeto vazio", () => {
    const def = normalizeDefinition({ nodes: [{ id: "a", type: "start" }], edges: [] });
    expect(def.nodes[0]!.config).toEqual({});
  });
});

describe("executeRun — casos degenerados", () => {
  test("definition vazia retorna output vazio sem steps", async () => {
    const { result } = await exec({ nodes: [], edges: [] });
    expect(result).toEqual({ output: {}, stepsExecuted: 0 });
  });

  test("sem nó de start lança erro", async () => {
    // Nó não-trigger que é alvo de uma aresta → não é elegível como start.
    await expect(
      exec({
        nodes: [{ id: "a", type: "noop", config: {} }],
        edges: [{ from: "ghost", to: "a" }],
      }),
    ).rejects.toThrow(/start/i);
  });
});

describe("executeRun — fluxo linear", () => {
  test("start → set_variable → end propaga output e grava steps", async () => {
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "sv", type: "set_variable", config: { name: "greeting", value: "olá" } },
        { id: "end", type: "end", config: { output: { msg: "{{ vars.greeting }}" } } },
      ],
      edges: [
        { from: "start", to: "sv" },
        { from: "sv", to: "end" },
      ],
    };
    const { runId, result } = await exec(def, { input: { seed: 1 } });
    expect(result.output).toEqual({ msg: "olá" });
    expect(result.stepsExecuted).toBe(3);

    const steps = await stepsOf(runId);
    expect(steps.map((s) => s.nodeId)).toEqual(["start", "sv", "end"]);
    expect(steps.every((s) => s.status === "success")).toBe(true);
  });
});

describe("executeRun — fork e fan-in", () => {
  test("fork paralelo converge num nó que espera ambos os ramos", async () => {
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "a", type: "noop", config: {} },
        { id: "b", type: "noop", config: {} },
        { id: "join", type: "noop", config: {} },
        { id: "end", type: "end", config: { output: { done: true } } },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "start", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const { runId, result } = await exec(def);
    expect(result.output).toEqual({ done: true });
    // join executa UMA vez só (espera os dois predecessores).
    const steps = await stepsOf(runId);
    const joinRuns = steps.filter((s) => s.nodeId === "join");
    expect(joinRuns).toHaveLength(1);
    expect(result.stepsExecuted).toBe(5);
  });
});

describe("executeRun — IF e branch morta", () => {
  test("ramo não escolhido é pulado (não gera step)", async () => {
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "if", type: "if", config: { left: true, op: "truthy" } },
        { id: "yes", type: "noop", config: {} },
        { id: "no", type: "noop", config: {} },
        { id: "end", type: "end", config: { output: { via: "yes" } } },
      ],
      edges: [
        { from: "start", to: "if" },
        { from: "if", to: "yes", label: "true" },
        { from: "if", to: "no", label: "false" },
        { from: "yes", to: "end" },
        { from: "no", to: "end" },
      ],
    };
    const { runId, result } = await exec(def);
    expect(result.output).toEqual({ via: "yes" });
    const ran = (await stepsOf(runId)).map((s) => s.nodeId);
    expect(ran).toContain("yes");
    expect(ran).not.toContain("no");
  });

  test("regressão: fan-in pós-IF dispara mesmo com um ramo morto", async () => {
    // start → if →(true) yes, →(false) no; yes/no → join → end.
    // O join tem in-degree 2; um predecessor conclui (live) e o outro é pulado
    // (dead). O join precisa disparar exatamente uma vez.
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "if", type: "if", config: { left: "", op: "truthy" } }, // → false
        { id: "yes", type: "noop", config: {} },
        { id: "no", type: "noop", config: {} },
        { id: "join", type: "noop", config: {} },
        { id: "end", type: "end", config: { output: { ok: true } } },
      ],
      edges: [
        { from: "start", to: "if" },
        { from: "if", to: "yes", label: "true" },
        { from: "if", to: "no", label: "false" },
        { from: "yes", to: "join" },
        { from: "no", to: "join" },
        { from: "join", to: "end" },
      ],
    };
    const { runId, result } = await exec(def);
    expect(result.output).toEqual({ ok: true });
    const steps = await stepsOf(runId);
    const ran = steps.map((s) => s.nodeId);
    expect(ran).toContain("no"); // ramo false
    expect(ran).not.toContain("yes"); // ramo true morto
    expect(steps.filter((s) => s.nodeId === "join")).toHaveLength(1);
    expect(steps.filter((s) => s.nodeId === "end")).toHaveLength(1);
  });
});

describe("executeRun — loop com back-edge (split_in_batches)", () => {
  test("itera o array em batches e sai pela aresta done", async () => {
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "split", type: "split_in_batches", config: { items: [1, 2, 3], batchSize: 1 } },
        { id: "work", type: "noop", config: {} },
        { id: "end", type: "end", config: { output: { finished: true } } },
      ],
      edges: [
        { from: "start", to: "split" },
        { from: "split", to: "work", label: "loop" },
        { from: "work", to: "split" }, // back-edge
        { from: "split", to: "end", label: "done" },
      ],
    };
    const { runId, result } = await exec(def);
    expect(result.output).toEqual({ finished: true });
    const steps = await stepsOf(runId);
    // split roda 4x (3 loops + 1 done), work 3x, start 1x, end 1x = 9.
    expect(steps.filter((s) => s.nodeId === "work")).toHaveLength(3);
    expect(steps.filter((s) => s.nodeId === "split")).toHaveLength(4);
    expect(result.stepsExecuted).toBe(9);
  });
});

describe("executeRun — proteção contra runaway", () => {
  test("ciclo sem término bate no MAX_STEPS e lança", async () => {
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "a", type: "noop", config: {} },
        { id: "b", type: "noop", config: {} },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" }, // ciclo infinito
      ],
    };
    await expect(exec(def)).rejects.toThrow(/limite de 1000|loop/i);
  }, 30_000);
});

describe("executeRun — cancelamento cooperativo", () => {
  test("checkCancelled=true entre nós aborta com CancelledError", async () => {
    let calls = 0;
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "a", type: "noop", config: {} },
        { id: "b", type: "noop", config: {} },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
      ],
    };
    // Deixa o start rodar (1ª checagem false), cancela antes do 2º nó.
    const promise = exec(def, {
      checkCancelled: async () => {
        calls++;
        return calls > 1;
      },
    });
    await expect(promise).rejects.toBeInstanceOf(CancelledError);
  });
});

describe("executeRun — stopAtNodeId", () => {
  test("encerra no nó alvo com o output dele, sem rodar downstream", async () => {
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "sv", type: "set_variable", config: { name: "x", value: "parou" } },
        { id: "end", type: "end", config: { output: { shouldNotReach: true } } },
      ],
      edges: [
        { from: "start", to: "sv" },
        { from: "sv", to: "end" },
      ],
    };
    const { runId, result } = await exec(def, { stopAtNodeId: "sv" });
    // set_variable (modo single) devolve output { name, value }.
    expect(result.output).toEqual({ name: "x", value: "parou" });
    const ran = (await stepsOf(runId)).map((s) => s.nodeId);
    expect(ran).toEqual(["start", "sv"]);
  });
});

describe("executeRun — falha de nó", () => {
  test("stop_and_error interrompe o run e marca o step como failed", async () => {
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "boom", type: "stop_and_error", config: { message: "abortado de propósito" } },
        { id: "end", type: "end", config: {} },
      ],
      edges: [
        { from: "start", to: "boom" },
        { from: "boom", to: "end" },
      ],
    };
    const runId = await newRunId();
    await expect(
      executeRun({ runId, definition: def, input: {}, env: {} }),
    ).rejects.toThrow("abortado de propósito");

    const steps = await stepsOf(runId);
    const boom = steps.find((s) => s.nodeId === "boom");
    expect(boom?.status).toBe("failed");
    expect((boom?.error as { message?: string })?.message).toBe("abortado de propósito");
    // `end` nunca rodou.
    expect(steps.some((s) => s.nodeId === "end")).toBe(false);
  });
});

describe("executeRun — pinnedData e nós visuais", () => {
  test("pinnedData substitui a execução do handler", async () => {
    // http_request pinado: o handler (que faria rede) nunca é chamado.
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "http", type: "http_request", config: { url: "https://exemplo.invalido" } },
        { id: "end", type: "end", config: { output: { code: "{{ prev.status }}" } } },
      ],
      edges: [
        { from: "start", to: "http" },
        { from: "http", to: "end" },
      ],
    };
    const { result } = await exec(def, {
      pinnedData: { http: { status: 200, body: "pinned" } },
    });
    expect(result.output).toEqual({ code: 200 });
  });

  test("nó visual (sticky_note) é ignorado pelo executor", async () => {
    const def = {
      nodes: [
        { id: "start", type: "start", config: {} },
        { id: "note", type: "sticky_note", config: { text: "anotação" } },
        { id: "end", type: "end", config: { output: { ok: 1 } } },
      ],
      edges: [{ from: "start", to: "end" }],
    };
    const { runId, result } = await exec(def);
    expect(result.output).toEqual({ ok: 1 });
    const ran = (await stepsOf(runId)).map((s) => s.nodeId);
    expect(ran).not.toContain("note");
  });
});
