import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import { env } from "../config/env";
import { logger } from "./logger";

let transporter: Transporter | null = null;

export function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
}

export function getTransporter(): Transporter {
  if (!isSmtpConfigured()) {
    throw new Error("SMTP não configurado — defina SMTP_HOST, SMTP_USER, SMTP_PASS e SMTP_FROM.");
  }
  if (!transporter) {
    const port = env.SMTP_PORT ?? 465;
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: {
        user: env.SMTP_USER!,
        pass: env.SMTP_PASS!,
      },
    });
  }
  return transporter;
}

/** URL pública do front (link de convite). */
export function getFrontendUrl(): string {
  const explicit = env.FRONTEND_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const fromCors = env.CORS_ORIGINS.split(",")[0]?.trim();
  if (fromCors) return fromCors.replace(/\/$/, "");
  return "http://localhost:5173";
}

export function buildInvitationAcceptUrl(invitationId: string): string {
  const url = new URL("/auth", getFrontendUrl());
  url.searchParams.set("invitation", invitationId);
  return url.toString();
}

export type OrganizationInvitationEmail = {
  to: string;
  organizationName: string;
  inviterName: string;
  role: string;
  inviteLink: string;
  expiresInHours: number;
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  member: "Membro",
};

function roleLabel(role: string): string {
  const primary = role.split(",")[0]?.trim() ?? "member";
  return ROLE_LABELS[primary] ?? primary;
}

function buildInvitationHtml(data: OrganizationInvitationEmail): string {
  const papel = roleLabel(data.role);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Convite para ${escapeHtml(data.organizationName)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <!-- Header -->
          <tr>
            <td style="background:#0f172a;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
              <span style="font-size:18px;font-weight:700;letter-spacing:-0.3px;color:#ffffff;">
                Workflows
              </span>
              <span style="color:#475569;font-size:18px;font-weight:400;margin:0 8px;">|</span>
              <span style="font-size:18px;font-weight:700;letter-spacing:-0.3px;color:#1447E6;">
                LAI
              </span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:40px 40px 32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.4px;">
                Você foi convidado
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                <strong style="color:#0f172a;">${escapeHtml(data.inviterName)}</strong>
                convidou você para participar da organização
                <strong style="color:#0f172a;">${escapeHtml(data.organizationName)}</strong>
                como <strong style="color:#0f172a;">${escapeHtml(papel)}</strong>.
              </p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
                <tr>
                  <td style="border-radius:8px;background:#1447E6;">
                    <a href="${data.inviteLink}"
                       style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:-0.1px;border-radius:8px;">
                      Aceitar convite →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Divider -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
                <tr>
                  <td style="border-top:1px solid #e2e8f0;"></td>
                </tr>
              </table>

              <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.6px;">
                Link alternativo
              </p>
              <p style="margin:0;font-size:12px;color:#64748b;word-break:break-all;line-height:1.5;">
                <a href="${data.inviteLink}" style="color:#1447E6;text-decoration:none;">${data.inviteLink}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
                O convite expira em <strong style="color:#64748b;">${data.expiresInHours} horas</strong>.
                Use o mesmo e-mail deste convite ao entrar ou criar sua conta.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Envia o e-mail de convite para organização.
 * Se SMTP não estiver configurado, apenas registra aviso (útil em dev).
 */
export async function sendOrganizationInvitationEmail(
  data: OrganizationInvitationEmail,
): Promise<void> {
  if (!isSmtpConfigured()) {
    logger.warn(
      { to: data.to, inviteLink: data.inviteLink },
      "SMTP não configurado — e-mail de convite não enviado",
    );
    return;
  }

  const transport = getTransporter();
  const subject = `Convite para ${data.organizationName} — Workflows`;
  const text = [
    `${data.inviterName} convidou você para ${data.organizationName} (${roleLabel(data.role)}).`,
    "",
    `Aceite o convite: ${data.inviteLink}`,
    "",
    `O link expira em ${data.expiresInHours} horas.`,
  ].join("\n");

  await transport.sendMail({
    from: env.SMTP_FROM!,
    to: data.to,
    subject,
    text,
    html: buildInvitationHtml(data),
  });

  logger.info({ to: data.to, organization: data.organizationName }, "invitation email sent");
}
