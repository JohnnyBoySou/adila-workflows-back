import { env } from "../../../config/env";
import { getTransporter, isSmtpConfigured } from "../../mail";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Envia um e-mail via SMTP usando o transporter compartilhado (lib/mail.ts).
 *
 * Config (todos interpolados):
 *   to:      string | string[]   — obrigatório
 *   from?:   string              — default env.SMTP_FROM
 *   cc?:     string | string[]
 *   bcc?:    string | string[]
 *   subject: string              — obrigatório
 *   text?:   string
 *   html?:   string
 *   replyTo?: string
 *
 * Output: { messageId, accepted, rejected }
 */
export const emailSendHandler: NodeHandler = async ({ node, context }) => {
  if (!isSmtpConfigured()) {
    throw new Error("email_send: SMTP não configurado (SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM).");
  }
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const to = cfg.to;
  const subject = cfg.subject;
  if (!to || (typeof to !== "string" && !Array.isArray(to))) {
    throw new Error("email_send: config.to é obrigatório");
  }
  if (typeof subject !== "string" || !subject) {
    throw new Error("email_send: config.subject é obrigatório");
  }
  if (cfg.text == null && cfg.html == null) {
    throw new Error("email_send: defina ao menos config.text ou config.html");
  }

  const transport = getTransporter();
  const mail: Record<string, unknown> = {
    from: typeof cfg.from === "string" && cfg.from ? cfg.from : env.SMTP_FROM!,
    to: to as string | string[],
    subject,
  };
  if (cfg.cc) mail.cc = cfg.cc as string | string[];
  if (cfg.bcc) mail.bcc = cfg.bcc as string | string[];
  if (typeof cfg.replyTo === "string") mail.replyTo = cfg.replyTo;
  if (typeof cfg.text === "string") mail.text = cfg.text;
  if (typeof cfg.html === "string") mail.html = cfg.html;
  const info = await transport.sendMail(mail);

  return {
    output: {
      messageId: info.messageId,
      accepted: info.accepted ?? [],
      rejected: info.rejected ?? [],
    },
  };
};
