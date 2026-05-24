import type { NodeHandler } from "../types";

/**
 * Disparo por novo e-mail recebido (poller IMAP).
 *
 * Worker IMAP externo enfileira um run por mensagem nova, com input no
 * shape `{ from, to, subject, text, html, attachments[], headers, uid }`.
 *
 * Config (consumida pelo poller):
 *   - host, port, secure, user, password (via env preferencialmente)
 *   - folder?: "INBOX"
 *   - markSeen?: boolean
 */
export const emailTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { email: context.input },
});
