import type { NodeHandler } from "../types";

/**
 * Nó de entrada. Ecoa o input do run pra ficar visível no log de steps E
 * pra que downstream possa referenciar via `{{ steps.<startId>.X }}`.
 *
 * IMPORTANTE: NÃO envelopa em `{input: ...}`. Antes era assim, mas isso
 * divergia do pin do editor (que grava `{body, headers, ...}` direto) e
 * quebrava templates que assumem `steps.START.body.X` — o template virava
 * `steps.START.input.body.X`. Devolve o input "raw" igual ao pin.
 */
export const startHandler: NodeHandler = async ({ context }) => ({
  output: context.input,
});
