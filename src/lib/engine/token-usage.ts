/**
 * Normaliza o consumo de tokens dos nós de IA num formato único pra persistir
 * no `workflow_run_steps`. Cada nó devolve `usage` num shape diferente:
 *
 *   - ai_chat / ai_agent (generateText, AI SDK v5+):
 *       usage = { inputTokens, outputTokens, totalTokens }
 *   - embeddings (embed/embedMany):
 *       usage = { tokens }   → embeddings só cobram input, não têm output
 *
 * O `model` sai do config do nó (ai_chat/ai_agent) ou do output (embeddings),
 * pra o custo ser calculado no read a partir da tabela de preço. Ver
 * [[workflow-audit-trail]] (padrão de não congelar valor sensível no banco —
 * aqui é o preço que não congelamos).
 */

export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  model: string | null;
};

function toInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

/**
 * Extrai o consumo de tokens do output de um step. Retorna `null` quando o nó
 * não consumiu LLM (nenhum `usage` reconhecível) — o executor então não grava
 * as colunas de token.
 */
export function extractTokenUsage(output: unknown, config: unknown): TokenUsage | null {
  const out = asRecord(output);
  if (!out) return null;
  const usage = asRecord(out.usage);
  if (!usage) return null;

  const promptTokens = toInt(usage.inputTokens);
  const completionTokens = toInt(usage.outputTokens);
  let total = toInt(usage.totalTokens);

  // Embeddings: usage = { tokens } — contam como input, sem output.
  const embedTokens = toInt(usage.tokens);
  const inputTokens = promptTokens ?? embedTokens;
  const outputTokens = completionTokens;
  if (total === null) {
    const sum = (inputTokens ?? 0) + (outputTokens ?? 0);
    total = sum > 0 ? sum : null;
  }

  // Sem nenhum número reconhecível → não é um nó de IA rastreável.
  if (inputTokens === null && outputTokens === null && total === null) return null;

  // Modelo: config.model (ai_chat/ai_agent) tem prioridade; output.model (embeddings) é fallback.
  const cfg = asRecord(config);
  const cfgModel = cfg && typeof cfg.model === "string" ? cfg.model : null;
  const outModel = typeof out.model === "string" ? out.model : null;

  return {
    inputTokens,
    outputTokens,
    totalTokens: total,
    model: cfgModel ?? outModel,
  };
}
