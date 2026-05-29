// Training Center backend service.
// Persistencia real en Postgres del Centro de Entrenamiento del Agente.
// Reemplaza el localStorage del frontend cuando este endpoint está disponible.
//
// Patrón: ensureSchema() idempotente, mismo que feedback.service.ts.

import { query } from "../database/db";
import { logger } from "../utils/logger";
import type {
  KnowledgeItemRow, TrainingQARow, TrainingVersionRow, KnowledgeGapRow,
  TrainingSettingsRow, KnowledgeStatus, KnowledgeType, Priority,
  ValidationStage, TrainingVersionStatus, GapStatus,
} from "../types/training.types";

let schemaEnsured = false;

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS kb_training_items (
        id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title                   TEXT NOT NULL,
        content                 TEXT NOT NULL DEFAULT '',
        summary                 TEXT NOT NULL DEFAULT '',
        module                  TEXT NOT NULL DEFAULT 'AMS',
        process                 TEXT NOT NULL DEFAULT 'AMS Genérico',
        type                    TEXT NOT NULL DEFAULT 'AMS_PROCEDURE'
                                CHECK (type IN ('INCIDENT_SOLUTION','RCA','FUNCTIONAL_STEP','SAP_CONFIG',
                                  'KNOWN_ERROR','FAQ','MEETING_MINUTES','TEST_CASE','AMS_PROCEDURE','USER_GUIDE')),
        source                  TEXT NOT NULL DEFAULT 'manual',
        tags                    TEXT[] NOT NULL DEFAULT '{}'::text[],
        priority                TEXT NOT NULL DEFAULT 'medium'
                                CHECK (priority IN ('low','medium','high','critical')),
        status                  TEXT NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT','PENDING_REVIEW','VALIDATED','PUBLISHED','ARCHIVED','REJECTED')),
        score                   INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
        version                 TEXT NOT NULL DEFAULT 'draft',
        author                  TEXT NOT NULL DEFAULT 'sistema',
        validated_by            TEXT,
        published_at            TIMESTAMPTZ,
        validation_stage        TEXT NOT NULL DEFAULT 'PENDING_FUNCTIONAL'
                                CHECK (validation_stage IN ('PENDING_FUNCTIONAL','PENDING_TECHNICAL','FULLY_VALIDATED','NOT_REQUIRED')),
        functional_validated_by TEXT,
        technical_validated_by  TEXT,
        rejection_reason        TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_kbt_items_status   ON kb_training_items(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_kbt_items_module   ON kb_training_items(module);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_kbt_items_updated  ON kb_training_items(updated_at DESC);`);

    await query(`
      CREATE TABLE IF NOT EXISTS kb_training_qa (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        knowledge_item_id UUID NOT NULL REFERENCES kb_training_items(id) ON DELETE CASCADE,
        question          TEXT NOT NULL,
        expected_answer   TEXT NOT NULL DEFAULT '',
        approved          BOOLEAN NOT NULL DEFAULT false,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_kbt_qa_item ON kb_training_qa(knowledge_item_id);`);

    await query(`
      CREATE TABLE IF NOT EXISTS kb_training_versions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        version         TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','READY','PUBLISHED','ROLLED_BACK','ARCHIVED')),
        item_count      INTEGER NOT NULL DEFAULT 0,
        validated_count INTEGER NOT NULL DEFAULT 0,
        published_count INTEGER NOT NULL DEFAULT 0,
        created_by      TEXT NOT NULL DEFAULT 'sistema',
        changelog       TEXT[] NOT NULL DEFAULT '{}'::text[],
        published_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_kbt_ver_created ON kb_training_versions(created_at DESC);`);

    await query(`
      CREATE TABLE IF NOT EXISTS kb_training_gaps (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title            TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        module           TEXT NOT NULL DEFAULT 'AMS',
        process          TEXT NOT NULL DEFAULT 'AMS Genérico',
        priority         TEXT NOT NULL DEFAULT 'medium'
                         CHECK (priority IN ('low','medium','high','critical')),
        suggested_action TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'OPEN'
                         CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','DISMISSED')),
        resolved_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_kbt_gaps_status ON kb_training_gaps(status);`);

    await query(`
      CREATE TABLE IF NOT EXISTS kb_training_settings (
        id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        min_score_to_publish            INTEGER NOT NULL DEFAULT 80,
        require_functional_validation   BOOLEAN NOT NULL DEFAULT true,
        require_technical_validation    BOOLEAN NOT NULL DEFAULT true,
        allow_auto_publish              BOOLEAN NOT NULL DEFAULT false,
        active_modules                  TEXT[] NOT NULL DEFAULT ARRAY['MM','SD','PP','EWM','QM','AMS','BTP']::text[],
        main_language                   TEXT NOT NULL DEFAULT 'es' CHECK (main_language IN ('es','en')),
        response_format                 TEXT NOT NULL DEFAULT 'structured'
                                        CHECK (response_format IN ('concise','structured','narrative')),
        version_retention               INTEGER NOT NULL DEFAULT 10,
        strict_mode                     BOOLEAN NOT NULL DEFAULT true,
        updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure kb_training schema failed");
  }
}

// ============================================================================
// KNOWLEDGE ITEMS
// ============================================================================
export interface ListItemsFilters {
  status?: KnowledgeStatus;
  module?: string;
  type?: KnowledgeType;
  minScore?: number;
  search?: string;
  tag?: string;
  limit?: number;
}

export async function listItems(filters: ListItemsFilters = {}): Promise<KnowledgeItemRow[]> {
  await ensureSchema();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.status)   { params.push(filters.status);  conds.push(`status = $${params.length}`); }
  if (filters.module)   { params.push(filters.module);  conds.push(`module = $${params.length}`); }
  if (filters.type)     { params.push(filters.type);    conds.push(`type = $${params.length}`); }
  if (typeof filters.minScore === "number") {
    params.push(filters.minScore); conds.push(`score >= $${params.length}`);
  }
  if (filters.tag)      { params.push(filters.tag);     conds.push(`$${params.length} = ANY(tags)`); }
  if (filters.search)   {
    params.push(`%${filters.search}%`);
    conds.push(`(title ILIKE $${params.length} OR summary ILIKE $${params.length} OR author ILIKE $${params.length})`);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(500, filters.limit ?? 200));
  const { rows } = await query<KnowledgeItemRow>(
    `SELECT * FROM kb_training_items ${where} ORDER BY updated_at DESC LIMIT ${limit}`,
    params
  );
  return rows;
}

export interface CreateItemInput {
  title: string;
  content: string;
  summary: string;
  module: string;
  process: string;
  type: KnowledgeType;
  source?: string;
  tags?: string[];
  priority?: Priority;
  status?: KnowledgeStatus;
  author?: string;
}

export async function createItem(input: CreateItemInput): Promise<KnowledgeItemRow> {
  await ensureSchema();
  const { rows } = await query<KnowledgeItemRow>(
    `INSERT INTO kb_training_items
       (title, content, summary, module, process, type, source, tags, priority, status, author)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.title.slice(0, 200),
      input.content,
      input.summary.slice(0, 500),
      input.module,
      input.process,
      input.type,
      input.source ?? "manual",
      input.tags?.filter(Boolean).slice(0, 8) ?? [],
      input.priority ?? "medium",
      input.status ?? "DRAFT",
      input.author ?? "sistema",
    ]
  );
  return rows[0]!;
}

export async function getItem(id: string): Promise<KnowledgeItemRow | null> {
  await ensureSchema();
  const { rows } = await query<KnowledgeItemRow>(
    `SELECT * FROM kb_training_items WHERE id = $1`, [id]
  );
  return rows[0] ?? null;
}

export interface UpdateItemInput {
  title?: string;
  content?: string;
  summary?: string;
  module?: string;
  process?: string;
  type?: KnowledgeType;
  source?: string;
  tags?: string[];
  priority?: Priority;
  status?: KnowledgeStatus;
  score?: number;
  version?: string;
  validatedBy?: string | null;
  publishedAt?: string | null;
  validationStage?: ValidationStage;
  functionalValidatedBy?: string | null;
  technicalValidatedBy?: string | null;
  rejectionReason?: string | null;
}

export async function updateItem(id: string, patch: UpdateItemInput): Promise<KnowledgeItemRow | null> {
  await ensureSchema();
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (patch.title !== undefined)   push("title", patch.title.slice(0, 200));
  if (patch.content !== undefined) push("content", patch.content);
  if (patch.summary !== undefined) push("summary", patch.summary.slice(0, 500));
  if (patch.module !== undefined)  push("module", patch.module);
  if (patch.process !== undefined) push("process", patch.process);
  if (patch.type !== undefined)    push("type", patch.type);
  if (patch.source !== undefined)  push("source", patch.source);
  if (patch.tags !== undefined)    push("tags", patch.tags.slice(0, 8));
  if (patch.priority !== undefined) push("priority", patch.priority);
  if (patch.status !== undefined)  push("status", patch.status);
  if (patch.score !== undefined)   push("score", Math.max(0, Math.min(100, patch.score)));
  if (patch.version !== undefined) push("version", patch.version);
  if (patch.validatedBy !== undefined)             push("validated_by", patch.validatedBy);
  if (patch.publishedAt !== undefined)             push("published_at", patch.publishedAt);
  if (patch.validationStage !== undefined)         push("validation_stage", patch.validationStage);
  if (patch.functionalValidatedBy !== undefined)   push("functional_validated_by", patch.functionalValidatedBy);
  if (patch.technicalValidatedBy !== undefined)    push("technical_validated_by", patch.technicalValidatedBy);
  if (patch.rejectionReason !== undefined)         push("rejection_reason", patch.rejectionReason);

  sets.push(`updated_at = now()`);
  if (sets.length === 1) return getItem(id);

  params.push(id);
  const { rows } = await query<KnowledgeItemRow>(
    `UPDATE kb_training_items SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] ?? null;
}

export async function deleteItem(id: string): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await query(`DELETE FROM kb_training_items WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// ============================================================================
// Q&A
// ============================================================================
export async function listQA(itemId?: string): Promise<TrainingQARow[]> {
  await ensureSchema();
  if (itemId) {
    const { rows } = await query<TrainingQARow>(
      `SELECT * FROM kb_training_qa WHERE knowledge_item_id = $1 ORDER BY created_at DESC`, [itemId]
    );
    return rows;
  }
  const { rows } = await query<TrainingQARow>(
    `SELECT * FROM kb_training_qa ORDER BY created_at DESC LIMIT 500`
  );
  return rows;
}

export async function createQA(items: { knowledgeItemId: string; question: string; expectedAnswer: string }[]): Promise<TrainingQARow[]> {
  await ensureSchema();
  if (items.length === 0) return [];
  const values: string[] = [];
  const params: unknown[] = [];
  items.forEach((it) => {
    params.push(it.knowledgeItemId, it.question, it.expectedAnswer);
    const p = params.length;
    values.push(`($${p - 2}, $${p - 1}, $${p})`);
  });
  const { rows } = await query<TrainingQARow>(
    `INSERT INTO kb_training_qa (knowledge_item_id, question, expected_answer) VALUES ${values.join(", ")} RETURNING *`,
    params
  );
  return rows;
}

export async function updateQA(id: string, patch: { question?: string; expectedAnswer?: string; approved?: boolean }): Promise<TrainingQARow | null> {
  await ensureSchema();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.question !== undefined)       { params.push(patch.question); sets.push(`question = $${params.length}`); }
  if (patch.expectedAnswer !== undefined) { params.push(patch.expectedAnswer); sets.push(`expected_answer = $${params.length}`); }
  if (patch.approved !== undefined)       { params.push(patch.approved); sets.push(`approved = $${params.length}`); }
  if (sets.length === 0) {
    const { rows } = await query<TrainingQARow>(`SELECT * FROM kb_training_qa WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
  params.push(id);
  const { rows } = await query<TrainingQARow>(
    `UPDATE kb_training_qa SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return rows[0] ?? null;
}

export async function deleteQA(id: string): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await query(`DELETE FROM kb_training_qa WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// ============================================================================
// VERSIONS
// ============================================================================
export async function listVersions(): Promise<TrainingVersionRow[]> {
  await ensureSchema();
  const { rows } = await query<TrainingVersionRow>(
    `SELECT * FROM kb_training_versions ORDER BY created_at DESC LIMIT 100`
  );
  return rows;
}

export async function createVersion(input: {
  version: string; description: string; createdBy: string;
  itemCount: number; validatedCount: number; publishedCount: number;
  changelog?: string[];
}): Promise<TrainingVersionRow> {
  await ensureSchema();
  const { rows } = await query<TrainingVersionRow>(
    `INSERT INTO kb_training_versions
       (version, description, status, item_count, validated_count, published_count, created_by, changelog)
     VALUES ($1, $2, 'DRAFT', $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.version,
      input.description,
      input.itemCount,
      input.validatedCount,
      input.publishedCount,
      input.createdBy,
      input.changelog ?? [],
    ]
  );
  return rows[0]!;
}

export async function updateVersionStatus(id: string, status: TrainingVersionStatus): Promise<TrainingVersionRow | null> {
  await ensureSchema();
  // si pasamos a PUBLISHED, archivar previas
  if (status === "PUBLISHED") {
    await query(`UPDATE kb_training_versions SET status = 'ARCHIVED' WHERE status = 'PUBLISHED' AND id <> $1`, [id]);
    const { rows } = await query<TrainingVersionRow>(
      `UPDATE kb_training_versions SET status = 'PUBLISHED', published_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows[0] ?? null;
  }
  const { rows } = await query<TrainingVersionRow>(
    `UPDATE kb_training_versions SET status = $1 WHERE id = $2 RETURNING *`, [status, id]
  );
  return rows[0] ?? null;
}

// ============================================================================
// GAPS
// ============================================================================
export async function listGaps(): Promise<KnowledgeGapRow[]> {
  await ensureSchema();
  const { rows } = await query<KnowledgeGapRow>(
    `SELECT * FROM kb_training_gaps ORDER BY created_at DESC LIMIT 500`
  );
  return rows;
}

export async function createGap(input: {
  title: string; description: string; module: string; process: string;
  priority: Priority; suggestedAction: string; status?: GapStatus;
}): Promise<KnowledgeGapRow> {
  await ensureSchema();
  const { rows } = await query<KnowledgeGapRow>(
    `INSERT INTO kb_training_gaps
       (title, description, module, process, priority, suggested_action, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.title, input.description, input.module, input.process, input.priority, input.suggestedAction, input.status ?? "OPEN"]
  );
  return rows[0]!;
}

export async function updateGap(id: string, patch: {
  title?: string; description?: string; module?: string; process?: string;
  priority?: Priority; suggestedAction?: string; status?: GapStatus;
}): Promise<KnowledgeGapRow | null> {
  await ensureSchema();
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (patch.title !== undefined)            push("title", patch.title);
  if (patch.description !== undefined)      push("description", patch.description);
  if (patch.module !== undefined)           push("module", patch.module);
  if (patch.process !== undefined)          push("process", patch.process);
  if (patch.priority !== undefined)         push("priority", patch.priority);
  if (patch.suggestedAction !== undefined)  push("suggested_action", patch.suggestedAction);
  if (patch.status !== undefined) {
    push("status", patch.status);
    if (patch.status === "RESOLVED") sets.push(`resolved_at = now()`);
  }
  if (sets.length === 0) {
    const { rows } = await query<KnowledgeGapRow>(`SELECT * FROM kb_training_gaps WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
  params.push(id);
  const { rows } = await query<KnowledgeGapRow>(
    `UPDATE kb_training_gaps SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params
  );
  return rows[0] ?? null;
}

export async function deleteGap(id: string): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await query(`DELETE FROM kb_training_gaps WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// ============================================================================
// SETTINGS (singleton)
// ============================================================================
export async function getSettings(): Promise<TrainingSettingsRow> {
  await ensureSchema();
  const { rows } = await query<TrainingSettingsRow>(`SELECT * FROM kb_training_settings ORDER BY updated_at DESC LIMIT 1`);
  if (rows[0]) return rows[0];
  // Crear settings default si no existen
  const { rows: created } = await query<TrainingSettingsRow>(
    `INSERT INTO kb_training_settings DEFAULT VALUES RETURNING *`
  );
  return created[0]!;
}

export interface UpdateSettingsInput {
  minScoreToPublish?: number;
  requireFunctionalValidation?: boolean;
  requireTechnicalValidation?: boolean;
  allowAutoPublish?: boolean;
  activeModules?: string[];
  mainLanguage?: "es" | "en";
  responseFormat?: "concise" | "structured" | "narrative";
  versionRetention?: number;
  strictMode?: boolean;
}

export async function updateSettings(patch: UpdateSettingsInput): Promise<TrainingSettingsRow> {
  const current = await getSettings();
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (patch.minScoreToPublish !== undefined)            push("min_score_to_publish", patch.minScoreToPublish);
  if (patch.requireFunctionalValidation !== undefined)  push("require_functional_validation", patch.requireFunctionalValidation);
  if (patch.requireTechnicalValidation !== undefined)   push("require_technical_validation", patch.requireTechnicalValidation);
  if (patch.allowAutoPublish !== undefined)             push("allow_auto_publish", patch.allowAutoPublish);
  if (patch.activeModules !== undefined)                push("active_modules", patch.activeModules);
  if (patch.mainLanguage !== undefined)                 push("main_language", patch.mainLanguage);
  if (patch.responseFormat !== undefined)               push("response_format", patch.responseFormat);
  if (patch.versionRetention !== undefined)             push("version_retention", patch.versionRetention);
  if (patch.strictMode !== undefined)                   push("strict_mode", patch.strictMode);
  sets.push("updated_at = now()");
  if (sets.length === 1) return current;
  params.push(current.id);
  const { rows } = await query<TrainingSettingsRow>(
    `UPDATE kb_training_settings SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params
  );
  return rows[0]!;
}

// ============================================================================
// SNAPSHOT (todo el estado en una llamada — útil para hidratar el frontend)
// ============================================================================
export interface TrainingSnapshot {
  knowledge: KnowledgeItemRow[];
  qa: TrainingQARow[];
  versions: TrainingVersionRow[];
  gaps: KnowledgeGapRow[];
  settings: TrainingSettingsRow;
}

export async function getSnapshot(): Promise<TrainingSnapshot> {
  await ensureSchema();
  const [knowledge, qa, versions, gaps, settings] = await Promise.all([
    listItems({ limit: 500 }),
    listQA(),
    listVersions(),
    listGaps(),
    getSettings(),
  ]);
  return { knowledge, qa, versions, gaps, settings };
}
