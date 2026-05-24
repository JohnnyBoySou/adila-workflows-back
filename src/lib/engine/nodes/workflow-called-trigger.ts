import type { NodeHandler } from "../types";

/**
 * Ponto de entrada quando este workflow é invocado por outro via
 * `execute_workflow`. Recebe os argumentos passados pelo caller como input.
 *
 * Sem config — o nó apenas marca o workflow como invocável e expõe o
 * payload do caller via `{{ steps[<nodeId>].args }}`.
 */
export const workflowCalledTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { args: context.input },
});
