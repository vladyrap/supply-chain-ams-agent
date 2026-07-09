// =============================================================================
// case-artifacts.service.ts — Artefactos de 1ª clase del caso (F4)
// =============================================================================
// Registra y lista artefactos (adjuntos, SAP Notes, ABAP, dumps ST22, logs,
// capturas, correos) asociados a un ticket. Multi-tenant. Redacta secretos/PII
// del content antes de persistir y calcula un hash SHA-256 para integridad.
// Crea el esquema en runtime (idempotente), espejo de la migración 012.
// =============================================================================

import { createHash } from "crypto";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { redactSecrets } from "../utils/redact";

export type CaseArtifactKind =
  | "sap_note" | "abap" | "attachment" | "evidence"
  | "log" | "dump" | "screenshot" | "email";

export const CASE_ARTIFACT_KINDS: CaseArtifactKind[] = [
  "sap_note", "abap", "attachment", "evidence", "log", "dump", "screenshot", "email",
];

export interface CaseArtifact {
  id: string;
  ticketKey: string;
  kind: CaseArtifactKind;
  title: string;
  ref: string | null;
  content: string | null;
  contentHash: string | null;
  meta: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
}

export interface AddCaseArtifactInput {
  kind: CaseArtifactKind;
  title: string;
  ref?: string | null;
  content?: string | null;
  meta?: Record<string, unknown> | null;
  createdBy?: string;
}

let schemaEnsured = false;

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS case_artifacts (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     TEXT NOT NULL DEFAULT 'default',
        ticket_key    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL,
        ref           TEXT,
        content       TEXT,
        content_hash  TEXT,
        meta          JSONB,
        created_by    TEXT NOT NULL DEFAULT 'system',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_case_artifacts_ticket ON case_artifacts (tenant_id, ticket_key, created_at DESC);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_case_artifacts_kind ON case_artifacts (tenant_id, kind);`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure case_artifacts schema failed (best-effort)");
  }
}

interface Row {
  id: string; ticket_key: string; kind: string; title: string;
  ref: string | null; content: string | null; content_hash: string | null;
  meta: Record<string, unknown> | null; created_by: string; created_at: string;
}

function rowToArtifact(r: Row): CaseArtifact {
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    kind: r.kind as CaseArtifactKind,
    title: r.title,
    ref: r.ref,
    content: r.content,
    contentHash: r.content_hash,
    meta: r.meta,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Registra un artefacto. El content se redacta (secretos/PII) y se hashea. */
export async function addCaseArtifact(
  tenantId: string,
  ticketKey: string,
  input: AddCaseArtifactInput,
): Promise<CaseArtifact | null> {
  await ensureSchema();
  const content = input.content ? redactSecrets(input.content) : null;
  const hash = content ? createHash("sha256").update(content).digest("hex") : null;
  try {
    const { rows } = await query<Row>(
      `INSERT INTO case_artifacts
         (tenant_id, ticket_key, kind, title, ref, content, content_hash, meta, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       RETURNING id, ticket_key, kind, title, ref, content, content_hash, meta, created_by, created_at`,
      [
        tenantId, ticketKey, input.kind, input.title.slice(0, 300),
        input.ref ?? null, content, hash,
        input.meta ? JSON.stringify(input.meta) : null,
        input.createdBy ?? "system",
      ],
    );
    return rows[0] ? rowToArtifact(rows[0]) : null;
  } catch (err) {
    logger.error({ err, ticketKey }, "addCaseArtifact failed");
    return null;
  }
}

/** Lista los artefactos de un ticket (más reciente primero). */
export async function listCaseArtifacts(tenantId: string, ticketKey: string): Promise<CaseArtifact[]> {
  await ensureSchema();
  try {
    const { rows } = await query<Row>(
      `SELECT id, ticket_key, kind, title, ref, content, content_hash, meta, created_by, created_at
         FROM case_artifacts
        WHERE tenant_id = $1 AND ticket_key = $2
        ORDER BY created_at DESC
        LIMIT 200`,
      [tenantId, ticketKey],
    );
    return rows.map(rowToArtifact);
  } catch (err) {
    logger.error({ err, ticketKey }, "listCaseArtifacts failed");
    return [];
  }
}
