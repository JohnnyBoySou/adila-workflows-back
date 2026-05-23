import type { NodeHandler } from "../types";

/**
 * Nó de entrada. Não faz nada — só ecoa o input do run pra ficar visível
 * no log de steps.
 */
export const startHandler: NodeHandler = async ({ context }) => ({
  output: { input: context.input },
});
