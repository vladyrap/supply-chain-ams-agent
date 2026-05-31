// Document Factory backend service.
// Persistencia real en Postgres. Reemplaza localStorage.

import { query } from "../database/db";
import { logger } from "../utils/logger";

let schemaEnsured = false;

export type DocumentType =
  | "RCA" | "MEETING_MINUTES" | "CLIENT_RESPONSE"
  | "FUNCTIONAL_SPEC" | "TECHNICAL_SPEC" | "TEST_CASE"
  | "USER_MANUAL" | "CUTOVER_PLAN" | "HYPERCARE_PLAN"
  | "EXECUTIVE_REPORT" | "GO_LIVE_CHECKLIST" | "REMEDIATION_PLAN"
  | "GAPS_REPORT" | "AGENT_CHANGELOG";

export type DocumentStatus = "DRAFT" | "GENERATED" | "REVIEWED" | "APPROVED" | "EXPORTED";

export type DocumentSourceType =
  | "incident" | "knowledge" | "playbook" | "scope_item" | "manual" | "evaluation";

export interface GeneratedDocument {
  id: string;
  title: string;
  documentType: DocumentType;
  sourceType: DocumentSourceType;
  sourceId: string | null;
  content: string;
  status: DocumentStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  formData: Record<string, string>;
}

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS generated_documents (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        document_type TEXT NOT NULL,
        source_type   TEXT NOT NULL DEFAULT 'manual',
        source_id     TEXT,
        content       TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','GENERATED','REVIEWED','APPROVED','EXPORTED')),
        created_by    TEXT NOT NULL DEFAULT 'demo',
        tags          TEXT[] NOT NULL DEFAULT '{}'::text[],
        form_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_doc_type    ON generated_documents(document_type);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_doc_status  ON generated_documents(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_doc_updated ON generated_documents(updated_at DESC);`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure documents schema failed");
  }
}

interface DocRow {
  id: string; title: string; document_type: DocumentType;
  source_type: DocumentSourceType; source_id: string | null;
  content: string; status: DocumentStatus; created_by: string;
  tags: string[]; form_data: Record<string, string>;
  created_at: string; updated_at: string;
}
function mapDoc(r: DocRow): GeneratedDocument {
  return {
    id: r.id, title: r.title, documentType: r.document_type,
    sourceType: r.source_type, sourceId: r.source_id,
    content: r.content, status: r.status, createdBy: r.created_by,
    tags: r.tags, formData: r.form_data || {},
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function getSnapshot(): Promise<{ documents: GeneratedDocument[] }> {
  await ensureSchema();
  const r = await query<DocRow>("SELECT * FROM generated_documents ORDER BY updated_at DESC LIMIT 500");
  return { documents: r.rows.map(mapDoc) };
}

export async function upsertDocument(d: GeneratedDocument): Promise<GeneratedDocument> {
  await ensureSchema();
  const now = new Date().toISOString();
  const res = await query<DocRow>(
    `INSERT INTO generated_documents (id,title,document_type,source_type,source_id,content,status,
       created_by,tags,form_data,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, document_type=EXCLUDED.document_type,
       source_type=EXCLUDED.source_type, source_id=EXCLUDED.source_id,
       content=EXCLUDED.content, status=EXCLUDED.status,
       tags=EXCLUDED.tags, form_data=EXCLUDED.form_data,
       updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [d.id, d.title, d.documentType, d.sourceType, d.sourceId || null, d.content, d.status,
     d.createdBy, d.tags || [], JSON.stringify(d.formData || {}),
     d.createdAt || now, now]
  );
  return mapDoc(res.rows[0]);
}

export async function deleteDocument(id: string): Promise<void> {
  await ensureSchema();
  await query("DELETE FROM generated_documents WHERE id = $1", [id]);
}

export async function resetDemo(): Promise<void> {
  await ensureSchema();
  await query("DELETE FROM generated_documents");
}
