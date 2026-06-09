// =============================================================================
// email.service.ts — Email transaccional con Resend (v1.1.0)
// =============================================================================
// Envía emails transaccionales si RESEND_API_KEY está seteada.
// Si no, log no-op (compatible con dev sin internet).
//
// Templates incluidos:
//   - sendWelcome: bienvenida + credenciales temporales
//   - sendPasswordReset: link de reset con token expirable
//   - sendAlertNotification: alerta de Alertmanager redirigida
//   - sendCustomerResponse: respuesta al cliente externo (con mirror Jira)
// =============================================================================

import { Resend } from "resend";
import { logger } from "../utils/logger";

const FROM = process.env.EMAIL_FROM ?? "AMS Platform <noreply@tuempresa.cl>";
let cachedClient: Resend | null = null;
let warned = false;

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
  const client = getClient();
  if (!client) return { sent: false, reason: "RESEND_API_KEY no configurado" };
  try {
    const { data, error } = await client.emails.send({
      from: FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo,
    });
    if (error) {
      logger.error({ err: error, to: opts.to }, "email.send failed");
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
    ? `<p><strong>Tu password temporal:</strong> <code>${opts.tempPassword}</code></p>
       <p style="color: #ef4444;">⚠ Cambiá esta contraseña en tu primer login.</p>`
    : "";
  return sendEmail({
    to: opts.to,
    subject: "Bienvenido a AMS Platform",
    html: `
<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #22d3ee;">¡Bienvenido a AMS Platform, ${opts.name}! 👋</h1>
  <p>Tu cuenta ya está activa. Podés acceder con tu email <strong>${opts.to}</strong>.</p>
  ${credsBlock}
  <div style="margin: 30px 0;">
    <a href="${opts.loginUrl}" style="background: #22d3ee; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
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
  <p>Hola ${opts.name},</p>
  <p>Recibimos una solicitud para resetear tu contraseña. Click en el botón abajo:</p>
  <div style="margin: 30px 0;">
    <a href="${opts.resetUrl}" style="background: #22d3ee; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
      Crear nueva contraseña
    </a>
  </div>
  <p style="color: #f59e0b;">⏱ Este link expira en ${opts.expiresInMinutes} minutos.</p>
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
  return sendEmail({
    to: opts.to,
    subject: `🚨 [${opts.severity.toUpperCase()}] ${opts.alertName} — AMS Platform`,
    html: `
<!DOCTYPE html>
<html>
<body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${sevColor}22; border-left: 4px solid ${sevColor}; padding: 14px;">
    <h2 style="margin: 0; color: ${sevColor};">⚠ ${opts.alertName}</h2>
    <p><strong>Severity:</strong> ${opts.severity}</p>
  </div>
  <h3 style="margin-top: 20px;">Resumen</h3>
  <p>${opts.summary}</p>
  <h3>Detalle</h3>
  <p>${opts.description}</p>
  ${opts.runbookUrl ? `<p><a href="${opts.runbookUrl}">Ver runbook</a></p>` : ""}
</body>
</html>`.trim(),
  });
}
