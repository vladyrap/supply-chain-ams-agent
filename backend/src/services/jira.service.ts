// Jira adapter real.
// Activo sólo si todas las env vars están presentes. Si no, devuelve resultado simulado
// (mismo shape) para que el frontend no rompa.
//
// Auth: Basic con email + API token (Atlassian Cloud).
// Endpoint: POST {baseUrl}/rest/api/3/issue
//
// SEGURIDAD: el token NUNCA sale del backend. El frontend nunca lo ve.

import { logger } from "../utils/logger";

export interface JiraPayload {
  project: { key: string };
  issuetype: { name: string };
  summary: string;
  description: string;
  priority?: { name: string };
  assignee?: { accountId: string };
  labels?: string[];
  components?: { name: string }[];
}

export interface JiraCreateResult {
  mode: "REAL" | "DEMO";
  ok: boolean;
  ticketId: string;
  ticketUrl: string;
  payload: JiraPayload;
  rawResponse?: unknown;
  error?: string;
}

interface JiraEnv {
  enabled: boolean;
  baseUrl: string;
  userEmail: string;
  apiToken: string;
  defaultProjectKey: string;
}

function readEnv(): JiraEnv {
  return {
    enabled: process.env.JIRA_ENABLED === "true",
    baseUrl: (process.env.JIRA_BASE_URL || "").replace(/\/+$/, ""),
    userEmail: process.env.JIRA_USER_EMAIL || "",
    apiToken: process.env.JIRA_API_TOKEN || "",
    defaultProjectKey: process.env.JIRA_PROJECT_KEY || "",
  };
}

export function jiraIsRealAvailable(): boolean {
  const e = readEnv();
  return !!(e.enabled && e.baseUrl && e.userEmail && e.apiToken);
}

/** Indica al frontend el estado actual del adapter (sin exponer credenciales). */
export function jiraStatus(): { enabled: boolean; mode: "REAL" | "DEMO"; baseUrl: string; projectKey: string; authConfigured: boolean } {
  const e = readEnv();
  const real = jiraIsRealAvailable();
  return {
    enabled: e.enabled,
    mode: real ? "REAL" : "DEMO",
    baseUrl: e.baseUrl,
    projectKey: e.defaultProjectKey,
    authConfigured: !!(e.userEmail && e.apiToken),
  };
}

function demoResult(payload: JiraPayload, reason?: string): JiraCreateResult {
  const num = 1000 + Math.floor(Math.random() * 9000);
  const projectKey = payload.project?.key || "AMS";
  const ticketId = `${projectKey}-${num}`;
  const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/+$/, "") || "https://jira.demo.local";
  return {
    mode: "DEMO",
    ok: true,
    ticketId,
    ticketUrl: `${baseUrl}/browse/${ticketId}`,
    payload,
    rawResponse: reason ? { simulated: true, reason } : { simulated: true },
  };
}

/**
 * Crea un issue Jira real si las credenciales están presentes; si no, simula.
 * `confirmReal=true` es OBLIGATORIO para que efectúe el POST real:
 * desde la UI esto sólo se setea tras una confirmación humana explícita.
 */
export async function createJiraIssue(payload: JiraPayload, opts: { confirmReal?: boolean } = {}): Promise<JiraCreateResult> {
  const env = readEnv();
  if (!jiraIsRealAvailable()) {
    return demoResult(payload, "credentials_not_configured");
  }
  if (!opts.confirmReal) {
    return demoResult(payload, "human_confirmation_required");
  }

  try {
    const auth = Buffer.from(`${env.userEmail}:${env.apiToken}`).toString("base64");
    // Adaptar description al formato ADF (Atlassian Document Format) si parece texto plano.
    const adfDescription = typeof payload.description === "string"
      ? {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: payload.description }] },
          ],
        }
      : payload.description;

    const body = {
      fields: {
        project: payload.project,
        issuetype: payload.issuetype,
        summary: payload.summary,
        description: adfDescription,
        ...(payload.priority ? { priority: payload.priority } : {}),
        ...(payload.assignee ? { assignee: payload.assignee } : {}),
        ...(payload.labels ? { labels: payload.labels } : {}),
        ...(payload.components ? { components: payload.components } : {}),
      },
    };

    const res = await fetch(`${env.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn({ status: res.status, data }, "jira create issue failed");
      return {
        mode: "REAL",
        ok: false,
        ticketId: "",
        ticketUrl: "",
        payload,
        rawResponse: data,
        error: (data as { errorMessages?: string[] })?.errorMessages?.join("; ") || `HTTP ${res.status}`,
      };
    }
    const ticketId = (data as { key?: string }).key || "";
    return {
      mode: "REAL",
      ok: true,
      ticketId,
      ticketUrl: `${env.baseUrl}/browse/${ticketId}`,
      payload,
      rawResponse: data,
    };
  } catch (err) {
    logger.error({ err }, "jira create issue exception");
    return {
      mode: "REAL",
      ok: false,
      ticketId: "",
      ticketUrl: "",
      payload,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
