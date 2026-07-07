// Organizational Memory (ROCCO — Fase 1 del activo #1).
//
// Ver docs/rocco/ORGANIZATIONAL_MEMORY_AND_KNOWLEDGE_GRAPH.md.
// Un MemoryRecord es una unidad de memoria con provenance obligatoria y, si su
// confianza es "evidence", con >=1 EvidenceUnit (Evidence by Design, Art. 4).
// Multi-tenant. Ingesta idempotente por dedupe_key (recomputar no duplica).
import { createHash } from "crypto";
import { query, withTx } from "../database/db";
import { logger } from "../utils/logger";

export type MemoryKind =
  | "incident_resolution" | "decision" | "assessment" | "config_change" | "learning" | "doc";
export type MemoryConfidence = "evidence" | "inferred" | "unverified";

export interface EvidenceInput { source: string; ref: string; hash?: string | null; }

export interface RecordMemoryInput {
  tenantId: string;
  kind: MemoryKind;
  title: string;
  body?: string;
  nodeRefs?: string[];
  evidence?: EvidenceInput[];
  provenance?: Record<string, unknown>;
  confidence?: MemoryConfidence;     // opcional: si no, se deriva de la evidencia
  dedupeKey?: string;
  createdBy?: string;
}

export interface MemoryRecordDTO {
  id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  confidence: MemoryConfidence;
  provenance: Record<string, unknown>;
  nodeRefs: string[];
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  evidence: { source: string; ref: string; hash: string | null }[];
}

let memSchemaEnsured = false;

/** Crea memory_record/memory_evidence si no existen (idempotente; best-effort). */
export async function ensureMemorySchema(): Promise<void> {
  if (memSchemaEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS memory_record (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', confidence TEXT NOT NULL DEFAULT 'inferred',
      provenance JSONB NOT NULL DEFAULT '{}'::jsonb, node_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
      version INTEGER NOT NULL DEFAULT 1, supersedes UUID, dedupe_key TEXT,
      content_hash TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT chk_mem_kind CHECK (kind IN ('incident_resolution','decision','assessment','config_change','learning','doc')),
      CONSTRAINT chk_mem_conf CHECK (confidence IN ('evidence','inferred','unverified'))
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mem_tenant_kind    ON memory_record (tenant_id, kind);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_mem_tenant_updated ON memory_record (tenant_id, updated_at DESC);`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mem_dedupe ON memory_record (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;`);
  await query(`
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id TEXT NOT NULL,
      record_id UUID NOT NULL REFERENCES memory_record(id) ON DELETE CASCADE,
      source TEXT NOT NULL, ref TEXT NOT NULL, hash TEXT,
      captured_by TEXT NOT NULL DEFAULT 'system',
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_mem_ev_record ON memory_evidence (tenant_id, record_id);`);
  memSchemaEnsured = true;
  logger.info("memory.schema.ensured");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Crea/actualiza un MemoryRecord + sus EvidenceUnits (transaccional).
 * Evidence by Design: confidence="evidence" exige >=1 evidencia. Si no se pasa
 * confidence, se deriva (evidencia presente → "evidence", si no → "inferred").
 * Idempotente por (tenant_id, dedupe_key): recomputar no duplica.
 */
export async function recordMemory(input: RecordMemoryInput): Promise<{ id: string; created: boolean }> {
  await ensureMemorySchema();
  const evidence = input.evidence ?? [];
  const confidence: MemoryConfidence = input.confidence ?? (evidence.length > 0 ? "evidence" : "inferred");
  if (confidence === "evidence" && evidence.length === 0) {
    throw new Error("memory: confidence='evidence' requiere al menos 1 EvidenceUnit (Evidence by Design).");
  }
  const body = input.body ?? "";
  const nodeRefs = input.nodeRefs ?? [];
  const provenance = input.provenance ?? { origin: "system", at: new Date().toISOString() };
  const contentHash = sha256(stableStringify({ k: input.kind, t: input.title, b: body, n: nodeRefs, c: confidence }));
  const createdBy = input.createdBy ?? "system";

  return withTx(async (client) => {
    let id: string;
    let created = true;
    if (input.dedupeKey) {
      const up = await client.query(
        `INSERT INTO memory_record (tenant_id,kind,title,body,confidence,provenance,node_refs,dedupe_key,content_hash,created_by,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10, now())
         ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
           kind=EXCLUDED.kind, title=EXCLUDED.title, body=EXCLUDED.body, confidence=EXCLUDED.confidence,
           provenance=EXCLUDED.provenance, node_refs=EXCLUDED.node_refs,
           version = CASE WHEN memory_record.content_hash <> EXCLUDED.content_hash
                          THEN memory_record.version + 1 ELSE memory_record.version END,
           content_hash=EXCLUDED.content_hash, updated_at=now()
         RETURNING id, (xmax = 0) AS inserted`,
        [input.tenantId, input.kind, input.title, body, confidence, JSON.stringify(provenance),
         JSON.stringify(nodeRefs), input.dedupeKey, contentHash, createdBy]
      );
      id = up.rows[0].id as string;
      created = up.rows[0].inserted === true;
    } else {
      const ins = await client.query(
        `INSERT INTO memory_record (tenant_id,kind,title,body,confidence,provenance,node_refs,content_hash,created_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9) RETURNING id`,
        [input.tenantId, input.kind, input.title, body, confidence, JSON.stringify(provenance),
         JSON.stringify(nodeRefs), contentHash, createdBy]
      );
      id = ins.rows[0].id as string;
    }
    // Sincronizar evidencia (replace) para reflejar el estado actual.
    await client.query(`DELETE FROM memory_evidence WHERE tenant_id=$1 AND record_id=$2`, [input.tenantId, id]);
    for (const e of evidence) {
      await client.query(
        `INSERT INTO memory_evidence (tenant_id,record_id,source,ref,hash) VALUES ($1,$2,$3,$4,$5)`,
        [input.tenantId, id, e.source, e.ref, e.hash ?? null]
      );
    }
    return { id, created };
  });
}

/**
 * Ingesta idempotente: convierte tickets resueltos/cerrados del tenant en
 * MemoryRecords (kind=incident_resolution) con evidencia (el ticket + su KB).
 * dedupe_key = ticket_resolved:<id> → recomputar no duplica.
 */
export async function ingestResolvedTickets(
  tenantId: string,
  opts: { daysBack?: number; limit?: number } = {},
): Promise<{ ingested: number; created: number; updated: number }> {
  await ensureMemorySchema();
  const daysBack = Math.min(Math.max(opts.daysBack ?? 3650, 1), 36500);
  const limit = Math.min(opts.limit ?? 500, 2000);
  const { rows } = await query<{
    id: string; code: string; title: string; summary: string | null;
    sap_module: string | null; client: string | null; resolved_at: string; kb_article_id: string | null;
  }>(
    `SELECT id, code, title, summary, sap_module, client, resolved_at, kb_article_id
       FROM support_tickets
      WHERE tenant_id = $1 AND status IN ('resolved','closed') AND resolved_at IS NOT NULL
        AND resolved_at > now() - ($2 || ' days')::interval
      ORDER BY resolved_at DESC LIMIT $3`,
    [tenantId, String(daysBack), limit]
  ).catch((err) => {
    logger.warn({ err, tenantId }, "memory.ingest.tickets.query.fail");
    return { rows: [] as never[], rowCount: 0 };
  });

  let created = 0;
  let updated = 0;
  for (const t of rows) {
    const evidence: EvidenceInput[] = [{ source: "ticket", ref: t.id, hash: sha256(stableStringify(t)) }];
    if (t.kb_article_id) evidence.push({ source: "kb", ref: t.kb_article_id });
    const nodeRefs = [t.id, ...(t.kb_article_id ? [t.kb_article_id] : [])];
    const body = [t.summary, t.sap_module ? `Módulo SAP: ${t.sap_module}` : null,
                  t.client ? `Cliente: ${t.client}` : null].filter(Boolean).join("\n");
    const r = await recordMemory({
      tenantId,
      kind: "incident_resolution",
      title: `${t.code} · ${t.title}`.slice(0, 200),
      body,
      nodeRefs,
      evidence,
      confidence: "evidence",
      provenance: { origin: "system", source: "ingest.ticket_resolved", at: new Date().toISOString(), resolved_at: t.resolved_at },
      dedupeKey: `ticket_resolved:${t.id}`,
    });
    if (r.created) created++; else updated++;
  }
  logger.info({ tenantId, ingested: rows.length, created, updated }, "memory.ingest.tickets");
  return { ingested: rows.length, created, updated };
}

interface MemoryRow {
  id: string; kind: MemoryKind; title: string; body: string; confidence: MemoryConfidence;
  provenance: Record<string, unknown>; node_refs: string[]; version: number;
  created_by: string; created_at: string; updated_at: string;
}
interface EvidenceRow { record_id: string; source: string; ref: string; hash: string | null; }

async function attachEvidence(tenantId: string, rows: MemoryRow[]): Promise<MemoryRecordDTO[]> {
  const ids = rows.map((r) => r.id);
  const evByRecord = new Map<string, { source: string; ref: string; hash: string | null }[]>();
  if (ids.length > 0) {
    const ev = await query<EvidenceRow>(
      `SELECT record_id, source, ref, hash FROM memory_evidence WHERE tenant_id=$1 AND record_id = ANY($2::uuid[])`,
      [tenantId, ids]
    );
    for (const e of ev.rows) {
      const list = evByRecord.get(e.record_id) ?? [];
      list.push({ source: e.source, ref: e.ref, hash: e.hash });
      evByRecord.set(e.record_id, list);
    }
  }
  return rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, body: r.body, confidence: r.confidence,
    provenance: r.provenance ?? {}, nodeRefs: r.node_refs ?? [], version: r.version,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    evidence: evByRecord.get(r.id) ?? [],
  }));
}

export async function listMemory(
  tenantId: string,
  opts: { kind?: string; limit?: number } = {},
): Promise<MemoryRecordDTO[]> {
  await ensureMemorySchema();
  const limit = Math.min(opts.limit ?? 100, 1000);
  const params: unknown[] = [tenantId];
  let where = `tenant_id = $1`;
  if (opts.kind) { params.push(opts.kind); where += ` AND kind = $${params.length}`; }
  params.push(limit);
  const { rows } = await query<MemoryRow>(
    `SELECT id,kind,title,body,confidence,provenance,node_refs,version,created_by,created_at,updated_at
       FROM memory_record WHERE ${where} ORDER BY updated_at DESC LIMIT $${params.length}`,
    params
  );
  return attachEvidence(tenantId, rows);
}

export async function getMemoryRecord(tenantId: string, id: string): Promise<MemoryRecordDTO | null> {
  await ensureMemorySchema();
  const { rows } = await query<MemoryRow>(
    `SELECT id,kind,title,body,confidence,provenance,node_refs,version,created_by,created_at,updated_at
       FROM memory_record WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id]
  );
  if (rows.length === 0) return null;
  const [dto] = await attachEvidence(tenantId, rows);
  return dto;
}
