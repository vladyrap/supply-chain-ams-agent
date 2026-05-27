// =============================================================
// SAP adapter — soporta 5 sub-tipos de integración outbound
// =============================================================
import { logger } from "../../utils/logger";
import type { SapConfig } from "../../types/integration.types";
import type { DeliveryResult } from "./adapters";

// ------------------------------------------------------------
// Render de templates simples: {{event}}, {{data.code}}, etc.
// ------------------------------------------------------------
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function renderTemplate(tpl: string, payload: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => {
    const v = getPath(payload, key.trim());
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

// ------------------------------------------------------------
// Auth helpers
// ------------------------------------------------------------
async function buildAuthHeaders(cfg: SapConfig): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  if (cfg.auth === "basic") {
    if (!cfg.username || !cfg.password) {
      throw new Error("basic auth requiere username + password");
    }
    h.Authorization = "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  } else if (cfg.auth === "bearer") {
    if (!cfg.bearerToken) throw new Error("bearer auth requiere bearerToken");
    h.Authorization = `Bearer ${cfg.bearerToken}`;
  } else if (cfg.auth === "oauth2_client_credentials") {
    if (!cfg.oauthTokenUrl || !cfg.oauthClientId || !cfg.oauthClientSecret) {
      throw new Error("oauth2 requiere oauthTokenUrl + oauthClientId + oauthClientSecret");
    }
    const tokenResp = await fetch(cfg.oauthTokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${cfg.oauthClientId}:${cfg.oauthClientSecret}`).toString("base64"),
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenResp.ok) {
      throw new Error(`oauth2 token endpoint HTTP ${tokenResp.status}`);
    }
    const tok = await tokenResp.json() as { access_token?: string };
    if (!tok.access_token) throw new Error("oauth2 sin access_token");
    h.Authorization = `Bearer ${tok.access_token}`;
  }
  if (cfg.sapClient) h["sap-client"] = cfg.sapClient;
  if (cfg.headers) Object.assign(h, cfg.headers);
  return h;
}

// ------------------------------------------------------------
// CSRF fetch para OData (cuando fetchCsrf=true)
// ------------------------------------------------------------
async function fetchCsrfToken(baseUrl: string, path: string, headers: Record<string, string>): Promise<{ token: string; cookie: string } | null> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: { ...headers, "x-csrf-token": "Fetch" },
    });
    const token = res.headers.get("x-csrf-token");
    const cookie = res.headers.get("set-cookie");
    if (token && cookie) return { token, cookie };
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Body builders por sub-tipo
// ------------------------------------------------------------
function buildDefaultBody(cfg: SapConfig, payload: Record<string, unknown>): string {
  if (cfg.bodyTemplate) {
    return renderTemplate(cfg.bodyTemplate, payload);
  }
  // Defaults razonables por adapter:
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const event = String(payload.event ?? "event");
  const title = (data.title as string) ?? (data.code as string) ?? event;
  const summary = (data.summary as string) ?? (data.message as string) ?? event;

  switch (cfg.adapter) {
    case "cloud_alm":
      // Forma del payload de Cloud ALM ITSM Incident (subset)
      return JSON.stringify({
        title,
        description: summary,
        priority: data.priority ?? "Medium",
        category: data.category ?? "AMS",
        externalReference: data.code ?? data.incident_id ?? null,
        source: "supply-chain-ams-agent",
        attributes: data,
      });
    case "btp_workflow":
      return JSON.stringify({
        definitionId: cfg.headers?.["X-WorkflowDefinitionId"] ?? "ams_event_handler",
        context: payload,
      });
    case "s4_odata":
      // OData genérico — el caller debe poner un bodyTemplate con la estructura exacta.
      // Default: enviar payload completo.
      return JSON.stringify(payload);
    case "idoc_http":
      // Para receivers HTTP de PI/PO, normalmente XML. Si no hay template:
      return `<?xml version="1.0" encoding="UTF-8"?>
<AmsEvent xmlns="urn:supply-chain-ams-agent:event">
  <Event>${event}</Event>
  <Timestamp>${payload.timestamp ?? ""}</Timestamp>
  <Title>${title}</Title>
  <Summary>${summary}</Summary>
  <Data>${JSON.stringify(data)}</Data>
</AmsEvent>`;
    case "solman":
      // SOAP envelope simple para Service Desk
      return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CreateNotification>
      <ShortText>${title}</ShortText>
      <LongText>${summary}</LongText>
      <Priority>${data.priority ?? "Medium"}</Priority>
      <ExternalRef>${data.code ?? ""}</ExternalRef>
    </CreateNotification>
  </soap:Body>
</soap:Envelope>`;
  }
}

function contentTypeFor(cfg: SapConfig): string {
  switch (cfg.adapter) {
    case "cloud_alm":
    case "s4_odata":
    case "btp_workflow":
      return "application/json";
    case "idoc_http":
      return "application/xml";
    case "solman":
      return "text/xml; charset=utf-8";
  }
}

// ------------------------------------------------------------
// Delivery principal
// ------------------------------------------------------------
export async function deliverSap(cfg: SapConfig, payload: Record<string, unknown>): Promise<DeliveryResult> {
  if (!cfg.baseUrl || !cfg.path) {
    return { ok: false, error: "baseUrl y path son obligatorios" };
  }
  let authHeaders: Record<string, string>;
  try {
    authHeaders = await buildAuthHeaders(cfg);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "auth setup error" };
  }

  const fullUrl = `${cfg.baseUrl.replace(/\/+$/, "")}${cfg.path.startsWith("/") ? cfg.path : "/" + cfg.path}`;
  const body = buildDefaultBody(cfg, payload);
  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(cfg),
    Accept: cfg.adapter === "solman" ? "text/xml" : "application/json",
    ...authHeaders,
  };

  // CSRF para OData (S/4HANA suele requerirlo)
  if (cfg.adapter === "s4_odata" && cfg.fetchCsrf) {
    const csrf = await fetchCsrfToken(cfg.baseUrl, cfg.path, authHeaders);
    if (csrf) {
      headers["x-csrf-token"] = csrf.token;
      headers["Cookie"] = csrf.cookie;
    }
  }

  if (cfg.adapter === "solman") {
    headers["SOAPAction"] = cfg.headers?.SOAPAction ?? "CreateNotification";
  }

  try {
    logger.info({ adapter: cfg.adapter, url: fullUrl }, "sap.deliver");
    const res = await fetch(fullUrl, { method: "POST", headers, body });
    const text = (await res.text().catch(() => "")).slice(0, 600);
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, responseExcerpt: text, error: `HTTP ${res.status}` };
    }
    return { ok: true, httpStatus: res.status, responseExcerpt: text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch error" };
  }
}
