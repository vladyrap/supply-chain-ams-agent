// Response provenance.
// Cada vez que el agente genera una respuesta, registramos qué Q&A y qué
// KnowledgeItems se usaron (vía few-shot injection o RAG). Cuando llega
// 👍/👎 a esa respuesta, podemos ajustar el score de esos items.
//
// Loop de aprendizaje local sin fine-tuning:
//   - 👎 sobre respuesta → items usados pierden 1 punto (mínimo 0)
//   - 👍 sobre respuesta → items usados ganan 1 punto (máximo 100)
//
// Tabla: agent_response_provenance (response_id ↔ item_ids / qa_ids).
// El response_id se materializa en el frontend al recibir el chat,
// y se pasa de vuelta cuando manda el feedback.

import { query } from "../database/db";
import { logger } from "../utils/logger";

let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS agent_response_provenance (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        response_id     TEXT NOT NULL UNIQUE,
        qa_ids          UUID[] NOT NULL DEFAULT '{}'::uuid[],
        item_ids        UUID[] NOT NULL DEFAULT '{}'::uuid[],
        rag_doc_ids     UUID[] NOT NULL DEFAULT '{}'::uuid[],
        user_query      TEXT,
        module          TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_resp_prov_response_id ON agent_response_provenance(response_id);`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure agent_response_provenance schema failed");
  }
}

export interface RecordProvenanceInput {
  responseId: string;
  qaIds: string[];
  itemIds: string[];
  ragDocIds?: string[];
  userQuery?: string;
  module?: string;
}

export async function recordProvenance(input: RecordProvenanceInput): Promise<void> {
  if (!input.responseId) return;
  // Solo guardar si hubo algo (sino es ruido)
  if (input.qaIds.length === 0 && input.itemIds.length === 0 && (input.ragDocIds ?? []).length === 0) return;
  await ensureSchema();
  try {
    await query(
      `INSERT INTO agent_response_provenance
         (response_id, qa_ids, item_ids, rag_doc_ids, user_query, module)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (response_id) DO NOTHING`,
      [
        input.responseId,
        input.qaIds,
        input.itemIds,
        input.ragDocIds ?? [],
        input.userQuery?.slice(0, 2000) ?? null,
        input.module ?? null,
      ]
    );
  } catch (err) {
    logger.debug({ err, responseId: input.responseId }, "recordProvenance fail");
  }
}

interface ProvenanceRow {
  qa_ids: string[];
  item_ids: string[];
}

export interface ReasoningTrace {
  responseId: string;
  userQuery: string | null;
  module: string | null;
  createdAt: string;
  fewShotQas: { id: string; question: string; expected_answer: string; module: string | null }[];
  fewShotItems: { id: string; title: string; module: string; status: string; score: number }[];
  ragDocs: { id: string; title: string | null; source_file: string | null }[];
  feedback: { kind: string; reason: string | null; created_at: string }[];
  hallucination: { suspicious: string[]; custom_z_y: string[]; risk_score: number } | null;
}

export async function getReasoningTrace(responseId: string): Promise<ReasoningTrace | null> {
  if (!responseId) return null;
  await ensureSchema();
  let prov: { qa_ids: string[]; item_ids: string[]; rag_doc_ids: string[]; user_query: string | null; module: string | null; created_at: string } | null = null;
  try {
    const { rows } = await query<{
      qa_ids: string[]; item_ids: string[]; rag_doc_ids: string[];
      user_query: string | null; module: string | null; created_at: string;
    }>(
      `SELECT qa_ids, item_ids, rag_doc_ids, user_query, module, created_at
         FROM agent_response_provenance
        WHERE response_id = $1`,
      [responseId]
    );
    prov = rows[0] ?? null;
  } catch (err) {
    logger.debug({ err }, "getReasoningTrace prov fail");
  }
  if (!prov) return null;

  // Q&A details
  let fewShotQas: ReasoningTrace["fewShotQas"] = [];
  if (prov.qa_ids.length > 0) {
    try {
      const { rows } = await query<{ id: string; question: string; expected_answer: string; module: string | null }>(
        `SELECT q.id, q.question, q.expected_answer, i.module
           FROM kb_training_qa q
           LEFT JOIN kb_training_items i ON i.id = q.knowledge_item_id
          WHERE q.id = ANY($1::uuid[])`,
        [prov.qa_ids]
      );
      fewShotQas = rows;
    } catch { /* */ }
  }

  let fewShotItems: ReasoningTrace["fewShotItems"] = [];
  if (prov.item_ids.length > 0) {
    try {
      const { rows } = await query<{ id: string; title: string; module: string; status: string; score: number }>(
        `SELECT id, title, module, status, score FROM kb_training_items WHERE id = ANY($1::uuid[])`,
        [prov.item_ids]
      );
      fewShotItems = rows;
    } catch { /* */ }
  }

  let ragDocs: ReasoningTrace["ragDocs"] = [];
  if (prov.rag_doc_ids.length > 0) {
    try {
      const { rows } = await query<{ id: string; title: string | null; source_file: string | null }>(
        `SELECT id, title, source_file FROM knowledge_documents WHERE id = ANY($1::uuid[])`,
        [prov.rag_doc_ids]
      );
      ragDocs = rows;
    } catch { /* */ }
  }

  // Feedback asociado
  let feedback: ReasoningTrace["feedback"] = [];
  try {
    const { rows } = await query<{ kind: string; reason: string | null; created_at: string }>(
      `SELECT kind, reason, created_at
         FROM ai_response_feedback
        WHERE metadata->>'responseId' = $1
        ORDER BY created_at DESC
        LIMIT 5`,
      [responseId]
    );
    feedback = rows;
  } catch { /* */ }

  // Hallucination
  let hallucination: ReasoningTrace["hallucination"] = null;
  try {
    const { rows } = await query<{ suspicious: string[]; custom_z_y: string[]; risk_score: number }>(
      `SELECT suspicious, custom_z_y, risk_score
         FROM agent_hallucinations
        WHERE response_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [responseId]
    );
    if (rows[0]) hallucination = rows[0];
  } catch { /* */ }

  return {
    responseId,
    userQuery: prov.user_query,
    module: prov.module,
    createdAt: prov.created_at,
    fewShotQas, fewShotItems, ragDocs, feedback, hallucination,
  };
}

export async function getProvenance(responseId: string): Promise<ProvenanceRow | null> {
  if (!responseId) return null;
  await ensureSchema();
  try {
    const { rows } = await query<ProvenanceRow>(
      `SELECT qa_ids, item_ids FROM agent_response_provenance WHERE response_id = $1`,
      [responseId]
    );
    return rows[0] ?? null;
  } catch (err) {
    logger.debug({ err, responseId }, "getProvenance fail");
    return null;
  }
}

/**
 * Ajusta el score de los KB items asociados a un response_id según el feedback.
 * 👍: +1 (cap 100). 👎: -1 (cap 0).
 * Para Q&A no hay score numérico — pero si negativo, marcamos approved=false
 * para que dejen de ser usadas en few-shot.
 */
export async function adjustScoreFromFeedback(
  responseId: string,
  kind: "positive" | "negative",
): Promise<{ itemsTouched: number; qasTouched: number }> {
  if (!responseId) return { itemsTouched: 0, qasTouched: 0 };
  const prov = await getProvenance(responseId);
  if (!prov) return { itemsTouched: 0, qasTouched: 0 };

  const delta = kind === "positive" ? 1 : -1;
  let itemsTouched = 0;
  let qasTouched = 0;

  if (prov.item_ids.length > 0) {
    try {
      const { rowCount } = await query(
        `UPDATE kb_training_items
            SET score = GREATEST(0, LEAST(100, score + $1)),
                updated_at = now()
          WHERE id = ANY($2::uuid[])`,
        [delta, prov.item_ids]
      );
      itemsTouched = rowCount ?? 0;
    } catch (err) {
      logger.warn({ err }, "adjustScore items fail");
    }
  }

  // Q&A: si feedback negativo, las desaprobamos para que salgan del few-shot
  if (kind === "negative" && prov.qa_ids.length > 0) {
    try {
      const { rowCount } = await query(
        `UPDATE kb_training_qa
            SET approved = false
          WHERE id = ANY($1::uuid[]) AND approved = true`,
        [prov.qa_ids]
      );
      qasTouched = rowCount ?? 0;
    } catch (err) {
      logger.warn({ err }, "adjustScore qa fail");
    }
  }

  // Invalidar few-shot cache para que la próxima request use scores actualizados
  if (itemsTouched > 0 || qasTouched > 0) {
    try {
      const { invalidateFewShotCache } = await import("./few-shot.service");
      invalidateFewShotCache();
    } catch { /* ignore */ }
  }

  logger.info(
    { responseId, kind, itemsTouched, qasTouched },
    "score ajustado por feedback humano"
  );
  return { itemsTouched, qasTouched };
}
