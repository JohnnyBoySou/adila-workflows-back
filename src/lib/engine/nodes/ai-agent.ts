import { generateText, jsonSchema, stepCountIs, tool, type ToolSet } from "ai";
import { anthropic, openai } from "../../ai";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Agente LLM com loop de ferramentas (tool calling).
 *
 * Diferença vs. `ai_chat`: aqui o modelo pode chamar ferramentas declaradas
 * em config e iterar até `maxSteps` (default 8). Cada ferramenta tem um
 * tipo de ação que o backend sabe executar:
 *
 *   - "http": faz HTTP request com body montado a partir do input do tool
 *             call. Útil pra dar ao agente acesso a APIs externas.
 *   - "echo": apenas devolve o input pro modelo — útil pra forçar saída
 *             estruturada ou registrar uma "decisão" do agente no histórico.
 *
 * Config:
 *   provider:  "anthropic" | "openai"          default "anthropic"
 *   model:     string                          ex: "claude-sonnet-4-6"
 *   prompt:    string                          (templatable, obrigatório)
 *   system?:   string                          (templatable)
 *   maxSteps?: number                          default 8
 *   tools?: Array<{
 *     name: string
 *     description: string
 *     inputSchema?: JSONSchema                 default {} (sem args)
 *     action?:
 *       | { type: "http", url: string, method?: string,
 *           headers?: Record<string,string>,
 *           bodyFromInput?: boolean }          default só echo
 *       | { type: "echo" }
 *   }>
 *
 * Output:
 *   { text, finishReason, usage, steps: Array<{ toolName, input, output }> }
 */
export const aiAgentHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  const provider = typeof cfg.provider === "string" ? cfg.provider : "anthropic";
  const modelId = cfg.model;
  if (typeof modelId !== "string" || !modelId) {
    throw new Error("ai_agent: config.model é obrigatório");
  }
  const prompt = cfg.prompt;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("ai_agent: config.prompt é obrigatório");
  }

  const model = provider === "openai" ? openai(modelId) : anthropic(modelId);
  const maxSteps = typeof cfg.maxSteps === "number" && cfg.maxSteps > 0 ? cfg.maxSteps : 8;

  const toolCalls: Array<{ toolName: string; input: unknown; output: unknown }> = [];
  const tools = buildTools(cfg.tools, toolCalls);

  const result = await generateText({
    model,
    prompt,
    system: typeof cfg.system === "string" ? cfg.system : undefined,
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : undefined,
    maxOutputTokens: typeof cfg.maxOutputTokens === "number" ? cfg.maxOutputTokens : undefined,
    tools,
    stopWhen: stepCountIs(maxSteps),
  });

  return {
    output: {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
      steps: toolCalls,
    },
  };
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema?: unknown;
  action?:
    | { type: "http"; url: string; method?: string; headers?: Record<string, string>; bodyFromInput?: boolean }
    | { type: "echo" };
};

function buildTools(
  raw: unknown,
  toolCalls: Array<{ toolName: string; input: unknown; output: unknown }>,
): ToolSet | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const t of raw as ToolDef[]) {
    if (!t || typeof t !== "object" || typeof t.name !== "string") continue;
    const schema = jsonSchema((t.inputSchema as object | undefined) ?? { type: "object", properties: {} });
    out[t.name] = tool({
      description: t.description ?? "",
      inputSchema: schema,
      execute: async (input: unknown) => {
        const output = await runToolAction(t, input);
        toolCalls.push({ toolName: t.name, input, output });
        return output;
      },
    });
  }
  return out as ToolSet;
}

async function runToolAction(t: ToolDef, input: unknown): Promise<unknown> {
  const action = t.action ?? { type: "echo" };
  if (action.type === "echo") return input;
  if (action.type === "http") {
    const res = await fetch(action.url, {
      method: action.method ?? "POST",
      headers: { "content-type": "application/json", ...(action.headers ?? {}) },
      body: action.bodyFromInput === false ? undefined : JSON.stringify(input ?? {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // mantém texto cru
    }
    return { status: res.status, ok: res.ok, body: parsed };
  }
  throw new Error(`ai_agent: tipo de action desconhecido em tool "${t.name}"`);
}
