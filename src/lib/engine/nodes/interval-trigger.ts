import type { NodeHandler } from "../types";

/**
 * Disparo a intervalos fixos (mais simples que cron).
 *
 * Scheduler externo enfileira o run conforme o intervalo configurado;
 * o handler apenas ecoa o input.
 *
 * Config (consumida pelo scheduler):
 *   - every: number
 *   - unit: "seconds" | "minutes" | "hours" | "days"
 */
export const intervalTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { input: context.input },
});
