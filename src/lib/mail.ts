import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

import { env } from "../config/env";

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
