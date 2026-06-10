// =============================================================================
// email.service.ts — Email transaccional con Resend (v1.1.1-hotfix)
// =============================================================================
// FIX C11 (audit v1.1.0): escapeHtml() en TODOS los `${...}` HTML para
// prevenir XSS via display name de Google ("<script>"). CRLF stripping en
// subject para prevenir header injection.
//
// Envía emails transaccionales si RESEND_API_KEY está seteada.
// Si no, log no-op (compatible con dev sin internet).
// =============================================================================

import { Resend } from "resend";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { logger } from "../utils/logger";

const FROM = process.env.EMAIL_FROM ?? "AMS Platform <noreply@tuempresa.cl>";
let cachedClient: Resend | null = null;
let cachedSmtp: Transporter | null = null;
let warned = false;

/**
 * v1.2.5-prod: usar SMTP si está configurado (Gmail App Password, sendgrid, etc).
 * Cae back a Resend si SMTP_HOST no está seteado.
 */
function getSmtpTransporter(): Transporter | null {
  if (!process.env.SMTP_HOST) return null;
  if (cachedSmtp) return cachedSmtp;
  cachedSmtp = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_USE_TLS === "true" && Number(process.env.SMTP_PORT ?? 587) === 465,
    requireTLS: process.env.SMTP_USE_TLS === "true",
    auth: process.env.SMTP_USER && process.env.SMTP_PASSWORD
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    pool: true,
    maxConnections: 3,
  });
  return cachedSmtp;
}

/** Escape HTML para evitar XSS al interpolar input no-trusted en templates. */
function esc(input: string | undefined | null): string {
  if (input == null) return "";
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Quitar CR/LF de subject + cualquier header para evitar header injection. */
function stripCrlf(input: string): string {
  return String(input).replace(/[\r\n]+/g, " ").trim();
}

/** Sanitizar URL: solo http/https permitido (evita javascript:, data:). */
function safeUrl(url: string | undefined): string {
  if (!url) return "#";
  const s = String(url).trim();
  if (!/^https?:\/\//i.test(s)) return "#";
  return esc(s); // y escape para atributo HTML
}

function getClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) {
    if (!warned) {
      logger.warn("email.service: RESEND_API_KEY no configurado — emails serán no-op");
      warned = true;
    }
    return null;
  }
  if (!cachedClient) cachedClient = new Resend(process.env.RESEND_API_KEY);
  return cachedClient;
}

export interface EmailResult {
  sent: boolean;
  id?: string;
  reason?: string;
}

/** Envía email genérico. Devuelve OK aunque no esté configurado (no rompe). */
export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}): Promise<EmailResult> {
  // v1.2.5-prod: prefer SMTP (compatible con Gmail App Password de Calmar).
  // Fallback a Resend si SMTP no configurado.
  const smtp = getSmtpTransporter();
  if (smtp) {
    try {
      const info = await smtp.sendMail({
        from: FROM,
        to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
        subject: stripCrlf(opts.subject),
        html: opts.html,
        text: opts.text,
        replyTo: opts.replyTo,
      });
      return { sent: true, id: info.messageId };
    } catch (err) {
      logger.error({ err, to: opts.to }, "email.send SMTP failed");
      return { sent: false, reason: (err as Error).message };
    }
  }
  const client = getClient();
  if (!client) return { sent: false, reason: "Email no configurado (ni SMTP ni Resend)" };
  try {
    const { data, error } = await client.emails.send({
      from: FROM,
      to: opts.to,
      subject: stripCrlf(opts.subject),
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo,
    });
    if (error) {
      logger.error({ err: error, to: opts.to }, "email.send Resend failed");
      return { sent: false, reason: error.message };
    }
    return { sent: true, id: data?.id };
  } catch (err) {
    logger.error({ err, to: opts.to }, "email.send exception");
    return { sent: false, reason: (err as Error).message };
  }
}

/** Welcome email para usuarios nuevos (post-signup o creado por admin). */
export async function sendWelcome(opts: {
  to: string;
  name: string;
  loginUrl: string;
  tempPassword?: string;
}): Promise<EmailResult> {
  const credsBlock = opts.tempPassword
    ? `<p><strong>Tu password temporal:</strong> <code>${esc(opts.tempPassword)}</code></p>
       <p style="color: #ef4444;">⚠ Cambiá esta contraseña en tu primer login.</p>`
    : "";
  return sendEmail({
    to: opts.to,
    subject: "Bienvenido a AMS Platform",
    html: `
<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #22d3ee;">¡Bienvenido a AMS Platform, ${esc(opts.name)}! 👋</h1>
  <p>Tu cuenta ya está activa. Podés acceder con tu email <strong>${esc(opts.to)}</strong>.</p>
  ${credsBlock}
  <div style="margin: 30px 0;">
    <a href="${safeUrl(opts.loginUrl)}" style="background: #22d3ee; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
      Acceder a AMS Platform
    </a>
  </div>
  <h2>¿Qué podés hacer?</h2>
  <ul>
    <li>📨 Crear tickets de soporte SAP con asistencia IA</li>
    <li>🤖 Recibir clasificación + recomendaciones automáticas</li>
    <li>📊 Ver el dashboard con KPIs en tiempo real</li>
    <li>🧠 Cargar tu knowledge base para mejorar las respuestas</li>
  </ul>
  <p style="color: #94a3b8; font-size: 12px; margin-top: 40px;">
    Si no esperabas este email, ignoralo. No vamos a contactarte de nuevo.
  </p>
</body>
</html>`.trim(),
    text: `Bienvenido a AMS Platform, ${opts.name}!\n\nTu cuenta está activa. Login: ${opts.loginUrl}\n\nEmail: ${opts.to}${opts.tempPassword ? `\nPassword temporal: ${opts.tempPassword}` : ""}`,
  });
}

/** Password reset email con token. */
export async function sendPasswordReset(opts: {
  to: string;
  name: string;
  resetUrl: string;
  expiresInMinutes: number;
}): Promise<EmailResult> {
  return sendEmail({
    to: opts.to,
    subject: "Reseteo de contraseña — AMS Platform",
    html: `
<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1>🔐 Reseteo de contraseña</h1>
  <p>Hola ${esc(opts.name)},</p>
  <p>Recibimos una solicitud para resetear tu contraseña. Click en el botón abajo:</p>
  <div style="margin: 30px 0;">
    <a href="${safeUrl(opts.resetUrl)}" style="background: #22d3ee; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
      Crear nueva contraseña
    </a>
  </div>
  <p style="color: #f59e0b;">⏱ Este link expira en ${Number(opts.expiresInMinutes) || 60} minutos.</p>
  <p style="color: #94a3b8; font-size: 12px;">
    Si NO solicitaste este reseteo, ignorá este email. Tu contraseña no cambiará.
  </p>
</body>
</html>`.trim(),
    text: `Hola ${opts.name}, click acá para resetear: ${opts.resetUrl} (expira en ${opts.expiresInMinutes} min)`,
  });
}

/** Forward de alerta crítica desde Alertmanager. */
export async function sendAlertNotification(opts: {
  to: string;
  alertName: string;
  severity: string;
  summary: string;
  description: string;
  runbookUrl?: string;
}): Promise<EmailResult> {
  const sevColor = opts.severity === "critical" ? "#ef4444" : opts.severity === "warning" ? "#f59e0b" : "#22d3ee";
  // Subject NO se interpola con esc() porque va plain text — pero sí strip CRLF
  // que hace stripCrlf en sendEmail. El severity ya viene controlado.
  return sendEmail({
    to: opts.to,
    subject: `🚨 [${String(opts.severity).toUpperCase()}] ${opts.alertName} — AMS Platform`,
    html: `
<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${sevColor}22; border-left: 4px solid ${sevColor}; padding: 14px;">
    <h2 style="margin: 0; color: ${sevColor};">⚠ ${esc(opts.alertName)}</h2>
    <p><strong>Severity:</strong> ${esc(opts.severity)}</p>
  </div>
  <h3 style="margin-top: 20px;">Resumen</h3>
  <p>${esc(opts.summary)}</p>
  <h3>Detalle</h3>
  <p>${esc(opts.description)}</p>
  ${opts.runbookUrl ? `<p><a href="${safeUrl(opts.runbookUrl)}">Ver runbook</a></p>` : ""}
</body>
</html>`.trim(),
  });
}
