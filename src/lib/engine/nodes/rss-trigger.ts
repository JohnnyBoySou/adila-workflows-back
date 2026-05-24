import type { NodeHandler } from "../types";

/**
 * Disparo por novo item em feed RSS/Atom.
 *
 * Poller externo consulta a URL no intervalo configurado e enfileira um
 * run por item novo, com input `{ title, link, pubDate, content, guid }`.
 *
 * Config:
 *   - url: string
 *   - pollIntervalMinutes?: number  (default 15)
 */
export const rssTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { item: context.input },
});
