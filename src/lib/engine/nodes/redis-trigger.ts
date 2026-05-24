import type { NodeHandler } from "../types";

/**
 * Disparo por mensagem em canal Redis pub/sub.
 *
 * Subscriber externo enfileira um run por mensagem, com input
 * `{ channel, message }` (ou `pattern` quando usa psubscribe).
 *
 * Config:
 *   - connectionRef: string
 *   - channel?: string
 *   - pattern?: string   (alternativo ao channel)
 */
export const redisTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { message: context.input },
});
