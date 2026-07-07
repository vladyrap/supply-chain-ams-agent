// SAP Inbound: recibe eventos que SAP envía a la plataforma.
// Cada source crea/relaciona una entidad downstream (incident, ticket, KB).
//
// Multi-tenant: los webhooks de SAP no traen credenciales JWT — solo un token
// inbound en el header X-Inbound-Token. Por eso validateToken devuelve el
// tenantId asociado al token, y el controller usa ESE tenantId para procesar
// el evento (NO req.tenantId que en webhooks sin auth cae al DEFAULT_TENANT).
import crypto from "node:crypto";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { saveIncident } from "./incident.service";
import { createTicket } from "./support/ticket.service";
import { createArticle } from "./support/kb.service";
import { emitEventFireAndForget } from "./integrations/delivery.service";

export type InboundSource =
  | "idoc" | "short_dump" | "oss_note" | "job_failure" | "transport" | "generic"
  // "clean_core": usado SOLO para scoping de tokens de servicio (connector Clean Core
  // → POST /api/memory/ingest/clean-core). NO pasa por processInboundEvent: tiene su
  // propio pipeline de ingesta (grafo + memoria). Por eso no está en VALID_SOURCES.
  | "clean_core";

const VALID_SOURCES: ReadonlySet<InboundSource> = new Set<InboundSource>([
  "idoc", "short_dump", "oss_note", "job_failure", "transport", "generic",
]);

export interface InboundToken {
  id: string;
  tenant_id: string;
  name: string;
  token_hash: string;
  sources: string[];
  active: boolean;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
}

// ============================================================
// Token management
// ============================================================
function hashToken(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

function generatePlainToken(): string {
  return "sapinb_" + crypto.randomBytes(24).toString("base64url");
}

export async function createToken(
  tenantId: string,
  input: { name: string; sources?: string[]; createdBy?: string },
): Promise<{ token: string; record: InboundToken }> {
  const plain = generatePlainToken();
  const hash = hashToken(plain);
  const sources = input.sources && input.sources.length > 0 ? input.sources : ["*"];
  const { rows } = await query<InboundToken>(
    `INSERT INTO sap_inbound_tokens (tenant_id, name, token_hash, sources, created_by, active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [tenantId, input.name, hash, sources, input.createdBy ?? null]
  );
  return { token: plain, record: rows[0]! };
}

export async function listTokens(tenantId: string): Promise<InboundToken[]> {
  const { rows } = await query<InboundToken>(
    `SELECT * FROM sap_inbound_tokens WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows;
}

export async function deleteToken(tenantId: string, id: string): Promise<boolean> {
  const r = await query(
    `DELETE FROM sap_inbound_tokens WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return r.rowCount > 0;
}

/**
 * Valida un token inbound. Devuelve el tokenId Y el tenantId asociado.
 * El caller (webhook) usa ese tenantId para procesar el evento, ya que
 * los webhooks de SAP no llegan con JWT/sesión.
 */
export async function validateToken(
  plain: string,
  source: InboundSource,
): Promise<
  | { ok: true; tokenId: string; tenantId: string }
  | { ok: false; reason: string }
> {
  if (!plain) return { ok: false, reason: "missing token" };
  const hash = hashToken(plain);
  const { rows } = await query<{ id: string; tenant_id: string; sources: string[]; active: boolean }>(
    `SELECT id, tenant_id, sources, active FROM sap_inbound_tokens WHERE token_hash = $1`,
    [hash]
  );
  const t = rows[0];
  if (!t) return { ok: false, reason: "token inválido" };
  if (!t.active) return { ok: false, reason: "token desactivado" };
  if (t.sources && t.sources.length > 0 && !t.sources.includes("*") && !t.sources.includes(source)) {
    return { ok: false, reason: `token no autorizado para source '${source}'` };
  }
  // Update last_used + count (fire-and-forget)
  query(`UPDATE sap_inbound_tokens SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1`, [t.id])
    .catch(() => undefined);
  return { ok: true, tokenId: t.id, tenantId: t.tenant_id };
}

// ============================================================
// Inbound events
// ============================================================
export interface InboundEventInput {
  source: InboundSource;
  sap_system?: string;
  sap_client?: string;
  severity?: "info" | "warning" | "error" | "critical";
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
  tokenHint?: string;
  fromIp?: string;
}

interface InboundEventRow {
  id: string;
  tenant_id: string;
  source: string;
  sap_system: string | null;
  sap_client: string | null;
  severity: string | null;
  title: string;
  summary: string | null;
  payload: unknown;
  incident_id: string | null;
  support_ticket_id: string | null;
  kb_article_id: string | null;
  auth_token_hint: string | null;
  received_from_ip: string | null;
  created_at: string;
  processed_at: string | null;
}

async function insertInboundRow(tenantId: string, input: InboundEventInput): Promise<InboundEventRow> {
  const { rows } = await query<InboundEventRow>(
    `INSERT INTO sap_inbound_events
       (tenant_id, source, sap_system, sap_client, severity, title, summary, payload,
        auth_token_hint, received_from_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
     RETURNING *`,
    [
      tenantId,
      input.source,
      input.sap_system ?? null,
      input.sap_client ?? null,
      input.severity ?? "info",
      input.title,
      input.summary ?? null,
      JSON.stringify(input.payload),
      input.tokenHint ?? null,
      input.fromIp ?? null,
    ]
  );
  return rows[0]!;
}

// Procesadores por source: cada uno crea la entidad downstream
async function processIdoc(tenantId: string, ev: InboundEventRow): Promise<{ incidentId?: string; ticketId?: string }> {
  // IDoc con error → incident + (si es crítico) ticket mesa
  try {
    const incident = await saveIncident(tenantId, {
      input: {
        message: `IDoc ${ev.title}: ${ev.summary ?? ""}`,
        user: "sap-inbound",
        client: ev.sap_system ?? "NO_INFORMADO",
        module: "INTEGRACION",
        environment: ev.sap_client ?? "NO_INFORMADO",
        attachments: [],
      },
      response: `Recibido desde SAP via inbound webhook. Payload: ${JSON.stringify(ev.payload).slice(0, 1500)}`,
      confidence: "no_detectada",
      model: "sap-inbound",
    });
    return { incidentId: incident.id };
  } catch (err) {
    logger.warn({ err }, "sap-inbound: idoc -> incident fail");
    return {};
  }
}

async function processShortDump(tenantId: string, ev: InboundEventRow): Promise<{ ticketId?: string }> {
  // Short dump (ST22) → ticket mesa con prioridad alta
  try {
    const sla = ev.severity === "critical" ? 60 : 240;
    const ticket = await createTicket(tenantId, {
      title: `[ST22] ${ev.title}`,
      summary: ev.summary ?? `Short dump recibido de ${ev.sap_system ?? "SAP"}.`,
      systemAffected: extractModuleFromPayload(ev.payload) ?? "NO_INFORMADO",
      category: "short_dump",
      priority: ev.severity === "critical" ? "critica" : "alta",
      slaMinutes: sla,
      assignedRole: "N2_BASIS",
      evidences: [
        { type: "sap_system", label: "Sistema SAP", value: ev.sap_system ?? "—" },
        { type: "client", label: "Mandante", value: ev.sap_client ?? "—" },
        { type: "payload", label: "Payload completo", value: JSON.stringify(ev.payload, null, 2).slice(0, 4000) },
      ],
    });
    return { ticketId: ticket.id };
  } catch (err) {
    logger.warn({ err }, "sap-inbound: short_dump -> ticket fail");
    return {};
  }
}

async function processOssNote(tenantId: string, ev: InboundEventRow): Promise<{ kbArticleId?: string }> {
  // Nueva OSS Note aplicada → KB article draft
  try {
    const data = ev.payload as Record<string, unknown>;
    const noteNum = String(data.note ?? data.note_number ?? ev.title);
    const article = await createArticle(tenantId, {
      title: `OSS Note ${noteNum}: ${ev.title}`,
      problem: (data.symptom as string) ?? ev.summary ?? "Problema descrito en nota OSS",
      solution: (data.solution as string) ?? `Aplicar la nota OSS ${noteNum}.\n\n${ev.summary ?? ""}`,
      system: extractModuleFromPayload(ev.payload) ?? undefined,
      category: "oss_note",
      tags: ["oss-note", `note-${noteNum}`],
      source: "manual",
    });
    return { kbArticleId: article.id };
  } catch (err) {
    logger.warn({ err }, "sap-inbound: oss_note -> kb fail");
    return {};
  }
}

async function processJobFailure(tenantId: string, ev: InboundEventRow): Promise<{ ticketId?: string }> {
  try {
    const ticket = await createTicket(tenantId, {
      title: `[SM37] Job falló: ${ev.title}`,
      summary: ev.summary ?? "Job cancelado en SAP.",
      systemAffected: extractModuleFromPayload(ev.payload) ?? "NO_INFORMADO",
      category: "job_failure",
      priority: ev.severity === "critical" ? "critica" : "alta",
      slaMinutes: ev.severity === "critical" ? 60 : 240,
      assignedRole: "N2_BASIS",
      evidences: [
        { type: "sap_system", label: "Sistema SAP", value: ev.sap_system ?? "—" },
        { type: "payload", label: "Detalles del job", value: JSON.stringify(ev.payload, null, 2).slice(0, 4000) },
      ],
    });
    return { ticketId: ticket.id };
  } catch (err) {
    logger.warn({ err }, "sap-inbound: job_failure -> ticket fail");
    return {};
  }
}

function extractModuleFromPayload(p: unknown): string | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  for (const key of ["module", "sap_module", "module_name", "application"]) {
    const v = o[key];
    if (typeof v === "string") return v.toUpperCase().slice(0, 16);
  }
  return null;
}

// ============================================================
// Entry point principal
// ============================================================
export async function processInboundEvent(
  tenantId: string,
  input: InboundEventInput,
): Promise<{
  event: InboundEventRow;
  downstream: { incidentId?: string; ticketId?: string; kbArticleId?: string };
}> {
  if (!VALID_SOURCES.has(input.source)) {
    throw new Error(`source inválido: ${input.source}`);
  }
  const ev = await insertInboundRow(tenantId, input);

  let downstream: { incidentId?: string; ticketId?: string; kbArticleId?: string } = {};
  try {
    if (input.source === "idoc")            downstream = await processIdoc(tenantId, ev);
    else if (input.source === "short_dump") downstream = await processShortDump(tenantId, ev);
    else if (input.source === "oss_note")   downstream = await processOssNote(tenantId, ev);
    else if (input.source === "job_failure")downstream = await processJobFailure(tenantId, ev);
    // transport / generic: solo log, no entidad downstream
  } catch (err) {
    logger.warn({ err, source: input.source }, "sap-inbound: downstream processing fail");
  }

  // Update fk + processed_at
  await query(
    `UPDATE sap_inbound_events
        SET incident_id = $1, support_ticket_id = $2, kb_article_id = $3, processed_at = now()
      WHERE id = $4 AND tenant_id = $5`,
    [downstream.incidentId ?? null, downstream.ticketId ?? null, downstream.kbArticleId ?? null, ev.id, tenantId]
  );

  // Emit integration event
  emitEventFireAndForget(tenantId, "sap.inbound", {
    source: input.source,
    severity: input.severity ?? "info",
    title: input.title,
    sap_system: input.sap_system,
    incident_id: downstream.incidentId,
    ticket_id: downstream.ticketId,
    kb_article_id: downstream.kbArticleId,
  });

  // refresh ev
  const { rows } = await query<InboundEventRow>(
    `SELECT * FROM sap_inbound_events WHERE id = $1 AND tenant_id = $2`,
    [ev.id, tenantId],
  );
  return { event: rows[0]!, downstream };
}

export async function listInboundEvents(
  tenantId: string,
  filters: { source?: InboundSource; limit?: number } = {},
): Promise<InboundEventRow[]> {
  const conds: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  if (filters.source) { params.push(filters.source); conds.push(`source = $${params.length}`); }
  const where = `WHERE ${conds.join(" AND ")}`;
  const limit = Math.min(filters.limit ?? 100, 200);
  params.push(limit);
  const { rows } = await query<InboundEventRow>(
    `SELECT * FROM sap_inbound_events ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return rows;
}

export async function getInboundEventById(
  tenantId: string,
  id: string,
): Promise<InboundEventRow | null> {
  const { rows } = await query<InboundEventRow>(
    `SELECT * FROM sap_inbound_events WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}
