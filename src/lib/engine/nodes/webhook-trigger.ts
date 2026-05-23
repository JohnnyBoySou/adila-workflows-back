import type { NodeHandler } from "../types";

/**
 * Nó de entrada de webhook.
 *
 * Não tem lógica própria — o disparo real acontece em `POST /hooks/:token`,
 * que enfileira o run com o body como `input`. Aqui só ecoamos esse input
 * pra ficar visível no log de steps e disponível como
 * `{{ steps[<nodeId>].body }}` para nós downstream.
 *
 * Existe como tipo separado de `start` pra que o canvas mostre visualmente
 * a forma de entrada — e pra que cada node `webhook_trigger` se associe a
 * um registro em `triggers` (via coluna `node_id`).
 */
export const webhookTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { body: context.input },
});
