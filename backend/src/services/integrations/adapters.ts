// Adapters: cada uno sabe cómo enviar a un tipo de destination.
// Devuelven { ok, httpStatus?, responseExcerpt?, error? }.
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { logger } from "../../utils/logger";
import type {
  WebhookConfig, SlackConfig, EmailConfig,
} from "../../types/integration.types";
export { deliverSap } from "./sap.adapter";

export interface DeliveryResult {
  ok: boolean;
  httpStatus?: number;
  responseExcerpt?: string;
  error?: string;
}

// ============================================================
// Webhook genérico (POST JSON)
// ============================================================
export async function deliverWebhook(
  cfg: WebhookConfig,
  payload: Record<string, unknown>
): Promise<DeliveryResult> {
  if (!cfg.url) return { ok: false, error: "url no configurada" };
  try {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "supply-chain-ams-agent/1.0",
      ...(cfg.headers ?? {}),
    };
    if (cfg.secret) {
      const sig = crypto.createHmac("sha256", cfg.secret).update(body).digest("hex");
      headers["X-Ams-Signature"] = `sha256=${sig}`;
    }
    const res = await fetch(cfg.url, { method: "POST", headers, body });
    const text = (await res.text().catch(() => "")).slice(0, 500);
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, responseExcerpt: text, error: `HTTP ${res.status}` };
    }
    return { ok: true, httpStatus: res.status, responseExcerpt: text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch error" };
  }
}

// ============================================================
// Slack (incoming webhook)
// ============================================================
function formatSlackText(payload: Record<string, unknown>): string {
  const event = String(payload.event ?? "evento");
  const data = payload.data as Record<string, unknown> | undefined;
  const lines: string[] = [`*${event}*`];
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "object") continue;
      lines.push(`• *${k}*: ${String(v).slice(0, 200)}`);
    }
  }
  return lines.join("\n");
}

export async function deliverSlack(
  cfg: SlackConfig,
  payload: Record<string, unknown>
): Promise<DeliveryResult> {
  if (!cfg.webhookUrl) return { ok: false, error: "webhookUrl no configurada" };
  try {
    const slackPayload: Record<string, unknown> = {
      text: formatSlackText(payload),
    };
    if (cfg.channel) slackPayload.channel = cfg.channel;
    const res = await fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload),
    });
    const text = (await res.text().catch(() => "")).slice(0, 200);
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, responseExcerpt: text, error: `HTTP ${res.status}: ${text}` };
    }
    return { ok: true, httpStatus: res.status, responseExcerpt: text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch error" };
  }
}

// ============================================================
// Email SMTP (via nodemailer)
// Lee SMTP_* del entorno. Si no está configurado, el envío falla con
// mensaje claro pero NO rompe el flujo del backend.
// ============================================================
function getMailer(): nodemailer.Transporter | null {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) {
    return null;
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function formatEmailHtml(payload: Record<string, unknown>): { subject: string; html: string } {
  const event = String(payload.event ?? "Evento");
  const data = payload.data as Record<string, unknown> | undefined;
  const subj = data && typeof data["title"] === "string" ? String(data["title"]) : event;
  const rows: string[] = [];
  if (data) {
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      const val = typeof v === "object" ? "<pre>" + escapeHtml(JSON.stringify(v, null, 2)).slice(0, 1000) + "</pre>" : escapeHtml(String(v));
      rows.push(`<tr><td style="padding:6px 12px; border:1px solid #ddd; font-weight:600">${escapeHtml(k)}</td><td style="padding:6px 12px; border:1px solid #ddd">${val}</td></tr>`);
    }
  }
  const html = `
    <div style="font-family: -apple-system, Segoe UI, sans-serif; color:#222;">
      <h2 style="margin:0 0 10px">${escapeHtml(event)}</h2>
      <table style="border-collapse:collapse; font-size:13px;">${rows.join("")}</table>
      <p style="color:#888; margin-top:14px; font-size:11px">Enviado automáticamente por supply-chain-ams-agent</p>
    </div>`;
  return { subject: subj, html };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

export async function deliverEmail(
  cfg: EmailConfig,
  payload: Record<string, unknown>
): Promise<DeliveryResult> {
  const mailer = getMailer();
  if (!mailer) {
    return {
      ok: false,
      error: "SMTP no configurado en backend (.env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD)",
    };
  }
  if (!cfg.to || cfg.to.length === 0) {
    return { ok: false, error: "lista de destinatarios vacía" };
  }
  try {
    const { subject, html } = formatEmailHtml(payload);
    const from = cfg.from || process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@ams.local";
    const fullSubject = (cfg.subject_prefix ? `${cfg.subject_prefix} ` : "") + subject;
    const info = await mailer.sendMail({
      from,
      to: cfg.to.join(", "),
      subject: fullSubject,
      html,
    });
    return { ok: true, responseExcerpt: `messageId=${info.messageId}` };
  } catch (err) {
    logger.warn({ err }, "email delivery fail");
    return { ok: false, error: err instanceof Error ? err.message : "smtp error" };
  }
}
