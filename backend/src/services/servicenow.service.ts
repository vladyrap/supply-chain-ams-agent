// ServiceNow adapter real.
// Activo sólo si todas las env vars están presentes.
//
// Auth: Basic con username + password (o API token).
// Endpoint: POST {instanceUrl}/api/now/table/{table}

import { logger } from "../utils/logger";

export interface ServiceNowPayload {
  short_description: string;
  description: string;
  priority: string;
  assignment_group: string;
  assigned_to?: string;
  category: string;
  subcategory: string;
}

export interface ServiceNowCreateResult {
  mode: "REAL" | "DEMO";
  ok: boolean;
  ticketId: string;
  ticketUrl: string;
  sysId?: string;
  payload: ServiceNowPayload;
  rawResponse?: unknown;
  error?: string;
}

interface SnEnv {
  enabled: boolean;
  instanceUrl: string;
  username: string;
  token: string;
  defaultTable: string;
}

function readEnv(): SnEnv {
  return {
    enabled: process.env.SERVICENOW_ENABLED === "true",
    instanceUrl: (process.env.SERVICENOW_INSTANCE_URL || "").replace(/\/+$/, ""),
    username: process.env.SERVICENOW_USERNAME || "",
    token: process.env.SERVICENOW_TOKEN || "",
    defaultTable: process.env.SERVICENOW_TABLE || "incident",
  };
}

export function serviceNowIsRealAvailable(): boolean {
  const e = readEnv();
  return !!(e.enabled && e.instanceUrl && e.username && e.token);
}

export function serviceNowStatus(): { enabled: boolean; mode: "REAL" | "DEMO"; instanceUrl: string; table: string; authConfigured: boolean } {
  const e = readEnv();
  const real = serviceNowIsRealAvailable();
  return {
    enabled: e.enabled,
    mode: real ? "REAL" : "DEMO",
    instanceUrl: e.instanceUrl,
    table: e.defaultTable,
    authConfigured: !!(e.username && e.token),
  };
}

function demoResult(payload: ServiceNowPayload, reason?: string): ServiceNowCreateResult {
  const ticketId = `INC${String(1_000_000 + Math.floor(Math.random() * 9_000_000)).padStart(7, "0")}`;
  const sysId = require("crypto").randomBytes(16).toString("hex");
  const instanceUrl = process.env.SERVICENOW_INSTANCE_URL?.replace(/\/+$/, "") || "https://servicenow.demo.local";
  return {
    mode: "DEMO",
    ok: true,
    ticketId,
    sysId,
    ticketUrl: `${instanceUrl}/nav_to.do?uri=incident.do?sys_id=${sysId}`,
    payload,
    rawResponse: reason ? { simulated: true, reason } : { simulated: true },
  };
}

export async function createServiceNowIncident(payload: ServiceNowPayload, opts: { confirmReal?: boolean } = {}): Promise<ServiceNowCreateResult> {
  const env = readEnv();
  if (!serviceNowIsRealAvailable()) {
    return demoResult(payload, "credentials_not_configured");
  }
  if (!opts.confirmReal) {
    return demoResult(payload, "human_confirmation_required");
  }

  try {
    const auth = Buffer.from(`${env.username}:${env.token}`).toString("base64");
    const res = await fetch(`${env.instanceUrl}/api/now/table/${env.defaultTable}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn({ status: res.status, data }, "servicenow create incident failed");
      return {
        mode: "REAL",
        ok: false,
        ticketId: "",
        ticketUrl: "",
        payload,
        rawResponse: data,
        error: (data as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`,
      };
    }
    const result = (data as { result?: { number?: string; sys_id?: string } }).result || {};
    const ticketId = result.number || "";
    const sysId = result.sys_id || "";
    return {
      mode: "REAL",
      ok: true,
      ticketId,
      sysId,
      ticketUrl: `${env.instanceUrl}/nav_to.do?uri=incident.do?sys_id=${sysId}`,
      payload,
      rawResponse: data,
    };
  } catch (err) {
    logger.error({ err }, "servicenow create incident exception");
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
