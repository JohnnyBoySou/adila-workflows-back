import type { NodeHandler } from "../types";

/**
 * Disparo agendado por expressão cron.
 *
 * Sem lógica própria — o scheduler externo enfileira o run no horário,
 * passando `{ firedAt, cron }` como input. Aqui só ecoamos pra ficar
 * visível no log de steps e disponível como `{{ steps[<nodeId>].* }}`.
 *
 * Config esperada (consumida pelo scheduler, não pelo handler):
 *   - cron: string  (ex: "0 9 * * *")
 *   - timezone?: string
 */
export const scheduleTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { input: context.input },
});
