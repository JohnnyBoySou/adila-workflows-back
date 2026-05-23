import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Pausa a execução por um tempo determinado.
 *
 * Config (um dos três é obrigatório):
 *   - ms?: number           — milissegundos
 *   - seconds?: number      — segundos
 *   - until?: string (ISO)  — espera até o instante absoluto
 *
 * Limite: 1h por chamada — pausas mais longas devem virar agendamento
 * externo, não segurar um worker.
 */
const MAX_WAIT_MS = 3_600_000;

export const waitHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  let ms: number;
  if (typeof cfg.ms === "number") {
    ms = cfg.ms;
  } else if (typeof cfg.seconds === "number") {
    ms = cfg.seconds * 1000;
  } else if (typeof cfg.until === "string") {
    const target = new Date(cfg.until).getTime();
    if (Number.isNaN(target)) throw new Error(`wait: "until" inválido (${cfg.until})`);
    ms = Math.max(0, target - Date.now());
  } else {
    throw new Error("wait: informe `ms`, `seconds` ou `until`");
  }

  if (ms < 0) ms = 0;
  if (ms > MAX_WAIT_MS) {
    throw new Error(`wait: ${ms}ms excede o máximo de ${MAX_WAIT_MS}ms`);
  }

  await new Promise<void>((resolve) => setTimeout(resolve, ms));
  return { output: { waitedMs: ms } };
};
