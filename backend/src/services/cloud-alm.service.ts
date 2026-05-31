// SAP Cloud ALM adapter.
// OAuth2 client_credentials flow + POST de test cases.
// Activo sólo si todas las env vars están presentes.

import { logger } from "../utils/logger";

export interface CloudAlmTestCasePayload {
  testCaseName: string;
  description: string;
  scopeItemId: string;
  scopeItems: string[];
  process: string;
  testType: string;
  environment: string;
  prerequisites: string;
  testSteps: { order: number; action: string; data?: string; expectedResult: string; actualResult?: string }[];
  expectedResults: string;
  evidenceReferences: { id: string; type: string; title: string }[];
  defects: { id: string; title: string; severity: string; status: string }[];
  status: string;
  owner: string;
  exportedAt: string;
}

export interface CloudAlmExportResult {
  mode: "REAL" | "DEMO" | "FUTURE";
  ok: boolean;
  externalId?: string;
  externalUrl?: string;
  payload: CloudAlmTestCasePayload;
  rawResponse?: unknown;
  error?: string;
}

interface AlmEnv {
  enabled: boolean;
  tenantUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  endpoint: string;
}

function readEnv(): AlmEnv {
  return {
    enabled: process.env.CLOUD_ALM_ENABLED === "true",
    tenantUrl: (process.env.CLOUD_ALM_TENANT_URL || "").replace(/\/+$/, ""),
    tokenUrl: process.env.CLOUD_ALM_TOKEN_URL || "",
    clientId: process.env.CLOUD_ALM_CLIENT_ID || "",
    clientSecret: process.env.CLOUD_ALM_CLIENT_SECRET || "",
    endpoint: process.env.CLOUD_ALM_TEST_ENDPOINT || "/v1/test-cases",
  };
}

export function cloudAlmIsRealAvailable(): boolean {
  const e = readEnv();
  return !!(e.enabled && e.tenantUrl && e.tokenUrl && e.clientId && e.clientSecret);
}

export function cloudAlmStatus(): { enabled: boolean; mode: "REAL" | "DEMO" | "FUTURE"; tenantUrl: string; authConfigured: boolean } {
  const e = readEnv();
  const real = cloudAlmIsRealAvailable();
  return {
    enabled: e.enabled,
    // FUTURE = no enabled. DEMO = enabled pero sin creds. REAL = todo OK.
    mode: !e.enabled ? "FUTURE" : (real ? "REAL" : "DEMO"),
    tenantUrl: e.tenantUrl,
    authConfigured: !!(e.clientId && e.clientSecret),
  };
}

// Cache simple del token (válido típicamente 1 hora; cacheamos 50 min).
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(env: AlmEnv): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const auth = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString("base64");
  const res = await fetch(env.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`Cloud ALM token endpoint failed: HTTP ${res.status}`);
  }
  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Cloud ALM no devolvió access_token");
  const ttl = (data.expires_in ?? 3600) * 1000;
  cachedToken = { token: data.access_token, expiresAt: Date.now() + Math.min(ttl, 50 * 60 * 1000) };
  return data.access_token;
}

function demoResult(payload: CloudAlmTestCasePayload, reason: string, mode: "DEMO" | "FUTURE" = "DEMO"): CloudAlmExportResult {
  const externalId = `CALM-${Math.floor(100000 + Math.random() * 900000)}`;
  const tenant = process.env.CLOUD_ALM_TENANT_URL?.replace(/\/+$/, "") || "https://cloud-alm.demo.local";
  return {
    mode,
    ok: true,
    externalId,
    externalUrl: `${tenant}/test-cases/${externalId}`,
    payload,
    rawResponse: { simulated: true, reason },
  };
}

export async function exportTestCaseToCloudAlm(
  payload: CloudAlmTestCasePayload,
  opts: { confirmReal?: boolean } = {}
): Promise<CloudAlmExportResult> {
  const env = readEnv();
  if (!env.enabled) {
    return demoResult(payload, "cloud_alm_disabled", "FUTURE");
  }
  if (!cloudAlmIsRealAvailable()) {
    return demoResult(payload, "credentials_not_configured");
  }
  if (!opts.confirmReal) {
    return demoResult(payload, "human_confirmation_required");
  }

  try {
    const token = await getAccessToken(env);
    const url = `${env.tenantUrl}${env.endpoint.startsWith("/") ? "" : "/"}${env.endpoint}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn({ status: res.status, data }, "cloud alm export failed");
      return {
        mode: "REAL",
        ok: false,
        payload,
        rawResponse: data,
        error: (data as { error?: string; message?: string })?.error || (data as { message?: string })?.message || `HTTP ${res.status}`,
      };
    }
    const externalId = (data as { id?: string; testCaseId?: string }).id || (data as { testCaseId?: string }).testCaseId || "";
    return {
      mode: "REAL",
      ok: true,
      externalId,
      externalUrl: externalId ? `${env.tenantUrl}/test-cases/${externalId}` : undefined,
      payload,
      rawResponse: data,
    };
  } catch (err) {
    logger.error({ err }, "cloud alm export exception");
    return {
      mode: "REAL",
      ok: false,
      payload,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
