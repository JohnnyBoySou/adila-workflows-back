import type { NodeHandler } from "../types";

/**
 * Disparo por notificação Postgres (`LISTEN`/`NOTIFY`).
 *
 * Listener externo mantém conexão `LISTEN <channel>` e enfileira um run
 * por NOTIFY recebido, com input `{ channel, payload, processId }`.
 *
 * Config:
 *   - connectionRef: string   nome lógico resolvido pelo worker
 *   - channel: string
 */
export const postgresTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { notification: context.input },
});
