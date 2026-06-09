// Embeddings semánticos para training items y Q&A.
//
// Reemplaza el match léxico Jaccard del few-shot por similitud coseno
// real. Cuando hay vectores, el agente encuentra Q&A relevantes aunque
// el usuario use sinónimos o reformule la pregunta.
//
// Tablas:
//   - kb_training_qa_embeddings (qa_id, embedding vector(768), text_hash)
//   - kb_training_item_embeddings (item_id, embedding vector(768), text_hash)
//
// Patrón:
//   1) Al aprobar Q&A o publicar item → encolamos su embedding.
//   2) buildSemanticFewShot(query) → embebe la query, hace cosine
//      contra ambas tablas, devuelve top-K.
//   3) Endpoint backfill para rellenar lo que ya existe.
//
// MT-2 (multi-tenant): CRÍTICO. La búsqueda semántica filtra SIEMPRE por
// tenant_id antes del ORDER BY <=> para que NINGÚN tenant pueda ver
// embeddings de otro cliente, ni siquiera por similitud.

import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";
import { logger } from "../utils/logger";

const EMBED_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBED_DIM = parseInt(process.env.GEMINI_EMBEDDING_DIM || "768", 10);
const TOP_QAS = 3;
const TOP_ITEMS = 2;
const MIN_SIMILARITY = 0.55;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

async function embed(text: string): Promise<number[]> {
  const ai = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp: any = await (ai.models as any).embedContent({
    model: EMBED_MODEL,
    contents: text.slice(0, 8000),
    config: { outputDimensionality: EMBED_DIM },
  });
  const vec = resp.embedding?.values ?? resp.embeddings?.[0]?.values ?? null;
  if (!vec) throw new Error("respuesta de embedding inválida");
  return vec as number[];
}

function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    // vector extension probablemente ya está, pero asegurar
    await query(`CREATE EXTENSION IF NOT EXISTS "vector"`).catch(() => null);
    await query(`
      CREATE TABLE IF NOT EXISTS kb_training_qa_embeddings (
        qa_id        UUID PRIMARY KEY REFERENCES kb_training_qa(id) ON DELETE CASCADE,
        embedding    vector(${EMBED_DIM}),
        text_hash    TEXT NOT NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS kb_training_item_embeddings (
        item_id      UUID PRIMARY KEY REFERENCES kb_training_items(id) ON DELETE CASCADE,
        embedding    vector(${EMBED_DIM}),
        text_hash    TEXT NOT NULL,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_kbt_qa_emb ON kb_training_qa_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)`).catch(() => null);
    await query(`CREATE INDEX IF NOT EXISTS idx_kbt_item_emb ON kb_training_item_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)`).catch(() => null);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure training-embeddings schema failed");
  }
}

// ========================= UPSERTS =========================
export async function upsertQaEmbedding(tenantId: string, qaId: string, text: string): Promise<void> {
  await ensureSchema();
  const hash = simpleHash(text);
  // Skip si ya está embeddeado con el mismo hash (mismo tenant)
  try {
    const { rows } = await query<{ text_hash: string }>(
      `SELECT text_hash FROM kb_training_qa_embeddings WHERE qa_id = $1 AND tenant_id = $2`,
      [qaId, tenantId]
    );
    if (rows[0]?.text_hash === hash) return;
  } catch { /* tabla no existe aún */ }
  try {
    const vec = await embed(text);
    await query(
      `INSERT INTO kb_training_qa_embeddings (tenant_id, qa_id, embedding, text_hash, updated_at)
       VALUES ($1, $2, $3::vector, $4, now())
       ON CONFLICT (qa_id) DO UPDATE
         SET embedding = EXCLUDED.embedding,
             text_hash = EXCLUDED.text_hash,
             tenant_id = EXCLUDED.tenant_id,
             updated_at = now()`,
      [tenantId, qaId, toPgVector(vec), hash]
    );
  } catch (err) {
    logger.warn({ err, qaId, tenantId }, "upsertQaEmbedding fail");
  }
}

export async function upsertItemEmbedding(tenantId: string, itemId: string, text: string): Promise<void> {
  await ensureSchema();
  const hash = simpleHash(text);
  try {
    const { rows } = await query<{ text_hash: string }>(
      `SELECT text_hash FROM kb_training_item_embeddings WHERE item_id = $1 AND tenant_id = $2`,
      [itemId, tenantId]
    );
    if (rows[0]?.text_hash === hash) return;
  } catch { /* */ }
  try {
    const vec = await embed(text);
    await query(
      `INSERT INTO kb_training_item_embeddings (tenant_id, item_id, embedding, text_hash, updated_at)
       VALUES ($1, $2, $3::vector, $4, now())
       ON CONFLICT (item_id) DO UPDATE
         SET embedding = EXCLUDED.embedding,
             text_hash = EXCLUDED.text_hash,
             tenant_id = EXCLUDED.tenant_id,
             updated_at = now()`,
      [tenantId, itemId, toPgVector(vec), hash]
    );
  } catch (err) {
    logger.warn({ err, itemId, tenantId }, "upsertItemEmbedding fail");
  }
}

// ========================= BACKFILL =========================
export interface BackfillReport {
  qasScanned: number;
  qasEmbedded: number;
  itemsScanned: number;
  itemsEmbedded: number;
  skippedSameHash: number;
}

export async function backfillTrainingEmbeddings(
  tenantId: string,
  opts: { limit?: number } = {}
): Promise<BackfillReport> {
  await ensureSchema();
  const report: BackfillReport = {
    qasScanned: 0, qasEmbedded: 0, itemsScanned: 0, itemsEmbedded: 0, skippedSameHash: 0,
  };
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));

  // Q&A aprobadas sin embedding (scoped al tenant)
  try {
    const { rows: qas } = await query<{ id: string; question: string; expected_answer: string }>(
      `SELECT q.id, q.question, q.expected_answer
         FROM kb_training_qa q
         LEFT JOIN kb_training_qa_embeddings e ON e.qa_id = q.id
        WHERE q.approved = true
          AND q.tenant_id = $1
          AND (e.qa_id IS NULL)
        ORDER BY q.created_at DESC
        LIMIT $2`,
      [tenantId, limit]
    );
    report.qasScanned = qas.length;
    for (const q of qas) {
      const text = `${q.question}\n\n${q.expected_answer}`;
      await upsertQaEmbedding(tenantId, q.id, text);
      report.qasEmbedded++;
    }
  } catch (err) {
    logger.warn({ err }, "backfill qa fail");
  }

  // Items PUBLISHED sin embedding (scoped al tenant)
  try {
    const { rows: items } = await query<{ id: string; title: string; summary: string; content: string }>(
      `SELECT i.id, i.title, i.summary, i.content
         FROM kb_training_items i
         LEFT JOIN kb_training_item_embeddings e ON e.item_id = i.id
        WHERE i.status = 'PUBLISHED'
          AND i.tenant_id = $1
          AND (e.item_id IS NULL)
        ORDER BY i.updated_at DESC
        LIMIT $2`,
      [tenantId, limit]
    );
    report.itemsScanned = items.length;
    for (const it of items) {
      const text = `${it.title}\n\n${it.summary}\n\n${it.content.slice(0, 4000)}`;
      await upsertItemEmbedding(tenantId, it.id, text);
      report.itemsEmbedded++;
    }
  } catch (err) {
    logger.warn({ err }, "backfill items fail");
  }

  logger.info({ tenantId, report }, "backfill training embeddings completed");
  return report;
}

// ========================= SEMANTIC FEW-SHOT =========================
export interface SemanticFewShotResult {
  qaIds: string[];
  itemIds: string[];
  qas: { id: string; question: string; expected_answer: string; similarity: number; module: string | null }[];
  items: { id: string; title: string; summary: string; module: string; similarity: number }[];
}

export async function buildSemanticFewShot(
  tenantId: string,
  userQuery: string,
  module?: string
): Promise<SemanticFewShotResult> {
  const empty: SemanticFewShotResult = { qaIds: [], itemIds: [], qas: [], items: [] };
  if (!userQuery || userQuery.trim().length < 3) return empty;
  await ensureSchema();

  let qVec: number[];
  try {
    qVec = await embed(userQuery);
  } catch (err) {
    logger.debug({ err }, "semantic few-shot: embed query fail");
    return empty;
  }
  const qVecLit = toPgVector(qVec);

  // Q&A top — CRÍTICO: filtrar por tenant_id ANTES del ORDER BY <=> para que
  // un cliente NUNCA vea embeddings de otro tenant, ni siquiera por similitud.
  let qaRows: { id: string; question: string; expected_answer: string; module: string | null; similarity: string }[] = [];
  try {
    const { rows } = await query<{ id: string; question: string; expected_answer: string; module: string | null; similarity: string }>(
      `SELECT q.id, q.question, q.expected_answer, i.module,
              (1 - (e.embedding <=> $1::vector))::text AS similarity
         FROM kb_training_qa_embeddings e
         JOIN kb_training_qa q ON q.id = e.qa_id
         LEFT JOIN kb_training_items i ON i.id = q.knowledge_item_id
        WHERE q.approved = true
          AND e.tenant_id = $3
          AND q.tenant_id = $3
        ORDER BY e.embedding <=> $1::vector
        LIMIT $2`,
      [qVecLit, TOP_QAS * 2, tenantId]
    );
    qaRows = rows;
  } catch (err) {
    logger.debug({ err }, "semantic few-shot qa search fail");
  }

  // Items top — mismo aislamiento por tenant_id.
  let itemRows: { id: string; title: string; summary: string; module: string; similarity: string }[] = [];
  try {
    const { rows } = await query<{ id: string; title: string; summary: string; module: string; similarity: string }>(
      `SELECT i.id, i.title, i.summary, i.module,
              (1 - (e.embedding <=> $1::vector))::text AS similarity
         FROM kb_training_item_embeddings e
         JOIN kb_training_items i ON i.id = e.item_id
        WHERE i.status = 'PUBLISHED'
          AND e.tenant_id = $3
          AND i.tenant_id = $3
        ORDER BY e.embedding <=> $1::vector
        LIMIT $2`,
      [qVecLit, TOP_ITEMS * 2, tenantId]
    );
    itemRows = rows;
  } catch (err) {
    logger.debug({ err }, "semantic few-shot items search fail");
  }

  // Filtrar por umbral + bonus de módulo
  const qas = qaRows
    .map((r) => {
      let sim = Number(r.similarity);
      if (module && r.module === module) sim += 0.05;
      return { id: r.id, question: r.question, expected_answer: r.expected_answer, module: r.module, similarity: sim };
    })
    .filter((q) => q.similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_QAS);

  const items = itemRows
    .map((r) => {
      let sim = Number(r.similarity);
      if (module && r.module === module) sim += 0.05;
      return { id: r.id, title: r.title, summary: r.summary, module: r.module, similarity: sim };
    })
    .filter((it) => it.similarity >= MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_ITEMS);

  return {
    qaIds: qas.map((q) => q.id),
    itemIds: items.map((i) => i.id),
    qas, items,
  };
}
