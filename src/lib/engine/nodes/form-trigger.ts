import type { NodeHandler } from "../types";

/**
 * Disparo por submissão de um formulário público.
 *
 * Rota HTTP `/forms/:token` renderiza o form a partir da `config.fields`
 * e enfileira o run com input no shape `{ fields: { ... }, submittedAt }`.
 *
 * Config:
 *   - title?: string
 *   - description?: string
 *   - fields: { name, label, type, required?, options? }[]
 */
export const formTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { submission: context.input },
});
