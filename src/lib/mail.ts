import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import { env } from "../config/env";
import { logger } from "./logger";

let transporter: Transporter | null = null;

function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM);
}

function getTransporter(): Transporter {
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
  return `
<!DOCTYPE html>
<html lang="pt-BR">
  <body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #111;">
    <p>Olá,</p>
    <p>
      <strong>${escapeHtml(data.inviterName)}</strong> convidou você para participar da organização
      <strong>${escapeHtml(data.organizationName)}</strong> no Workflows como <strong>${escapeHtml(papel)}</strong>.
    </p>
    <p>
      <a href="${data.inviteLink}" style="display: inline-block; padding: 10px 18px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">
        Aceitar convite
      </a>
    </p>
    <p style="font-size: 13px; color: #555;">
      Ou copie e cole no navegador:<br />
      <a href="${data.inviteLink}">${data.inviteLink}</a>
    </p>
    <p style="font-size: 12px; color: #777;">
      O convite expira em ${data.expiresInHours} horas. Use o mesmo e-mail deste convite ao entrar ou criar conta.
    </p>
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
