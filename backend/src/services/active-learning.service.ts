// Active learning loop.
//
// Identifica Q&A "borderline" — las que el agente ni acierta ni falla
// claramente. Score Gemini en rango 40-69 según las últimas evaluaciones.
// Estas son las más valiosas para que el humano las revise: una pequeña
// edición puede mover una "partial" a "pass" y mejorar el corpus.
//
// El endpoint priorizado devuelve estas Q&A ordenadas por uncertainty.

import { query } from "../database/db";
import { logger } from "../utils/logger";

export interface BorderlineQA {
  qaId: string;
  question: string;
  expectedAnswer: string;
  module: string | null;
  itemTitle: string | null;
  itemStatus: string | null;
  latestScore: number;
  latestVerdict: string;
  latestNotes: string | null;
  evalCount: number;        // cuantas veces fue evaluada
  avgScore: number;
  uncertainty: number;      // distancia al borde más cercano (50)
  approved: boolean;
}

export interface BorderlineReport {
  count: number;
  items: BorderlineQA[];
}

const MIN_SCORE = 40;
const MAX_SCORE = 69;

export async function getBorderlineQAs(opts: { limit?: number } = {}): Promise<BorderlineReport> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30));

  let rows: {
    qa_id: string; question: string; expected_answer: string;
    module: string | null; item_title: string | null; item_status: string | null;
    latest_score: number; latest_verdict: string; latest_notes: string | null;
    eval_count: string; avg_score: string; approved: boolean;
  }[] = [];
  try {
    const r = await query<{
      qa_id: string; question: string; expected_answer: string;
      module: string | null; item_title: string | null; item_status: string | null;
      latest_score: number; latest_verdict: string; latest_notes: string | null;
      eval_count: string; avg_score: string; approved: boolean;
    }>(
      `WITH per_qa AS (
        SELECT
          qa_id,
          count(*)::text AS eval_count,
          round(avg(score))::int AS avg_score,
          (array_agg(score    ORDER BY created_at DESC))[1] AS latest_score,
          (array_agg(verdict  ORDER BY created_at DESC))[1] AS latest_verdict,
          (array_agg(notes    ORDER BY created_at DESC))[1] AS latest_notes
        FROM qa_eval_results
        GROUP BY qa_id
      )
      SELECT
        p.qa_id, q.question, q.expected_answer, i.module,
        i.title AS item_title, i.status AS item_status,
        p.latest_score, p.latest_verdict, p.latest_notes,
        p.eval_count::text, p.avg_score::text, q.approved
      FROM per_qa p
      JOIN kb_training_qa q ON q.id = p.qa_id
      LEFT JOIN kb_training_items i ON i.id = q.knowledge_item_id
      WHERE p.avg_score BETWEEN $1 AND $2
      ORDER BY ABS(p.avg_score - 50) ASC, p.eval_count DESC
      LIMIT $3`,
      [MIN_SCORE, MAX_SCORE, limit]
    );
    rows = r.rows;
  } catch (err) {
    logger.debug({ err }, "borderline query fail");
  }

  const items: BorderlineQA[] = rows.map((r) => {
    const avg = Number(r.avg_score);
    return {
      qaId: r.qa_id,
      question: r.question,
      expectedAnswer: r.expected_answer,
      module: r.module,
      itemTitle: r.item_title,
      itemStatus: r.item_status,
      latestScore: r.latest_score,
      latestVerdict: r.latest_verdict,
      latestNotes: r.latest_notes,
      evalCount: Number(r.eval_count),
      avgScore: avg,
      uncertainty: Math.abs(50 - avg),  // 0 = peor, 9 mejor lejano de 50
      approved: r.approved,
    };
  });

  return { count: items.length, items };
}
