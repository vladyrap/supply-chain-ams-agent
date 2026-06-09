// KB curada de Mesa de Soporte. Distinta del RAG documental (knowledge_items).
// Aquí guardamos artículos con estructura "problema → solución" aprobados.
import { query } from "../../database/db";
import { logger } from "../../utils/logger";
import type { KbArticle, KbStatus } from "../../types/support.types";

export interface CreateKbInput {
  title: string;
  problem: string;
  solution: string;
  system?: string;
  category?: string;
  tags?: string[];
  source?: "manual" | "from_ticket" | "from_meeting";
  source_ticket_id?: string;
  created_by?: string;
}

export async function createArticle(tenantId: string, input: CreateKbInput): Promise<KbArticle> {
  const { rows } = await query<KbArticle>(
    `INSERT INTO kb_articles
       (tenant_id, title, problem, solution, system, category, tags, source, source_ticket_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      tenantId,
      input.title,
      input.problem,
      input.solution,
      input.system ?? null,
      input.category ?? null,
      input.tags ?? [],
      input.source ?? "manual",
      input.source_ticket_id ?? null,
      input.created_by ?? null,
    ]
  );
  return rows[0]!;
}

export async function listArticles(tenantId: string, filters: {
  status?: KbStatus;
  system?: string;
  category?: string;
} = {}): Promise<KbArticle[]> {
  const conds: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  if (filters.status)   { params.push(filters.status); conds.push(`status = $${params.length}`); }
  if (filters.system)   { params.push(filters.system); conds.push(`system = $${params.length}`); }
  if (filters.category) { params.push(filters.category); conds.push(`category = $${params.length}`); }
  const where = `WHERE ${conds.join(" AND ")}`;
  const { rows } = await query<KbArticle>(
    `SELECT * FROM kb_articles ${where} ORDER BY status, helpful_count DESC, created_at DESC LIMIT 200`,
    params
  );
  return rows;
}

export async function getArticleById(tenantId: string, id: string): Promise<KbArticle | null> {
  const { rows } = await query<KbArticle>(
    `SELECT * FROM kb_articles WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function approveArticle(tenantId: string, id: string, approvedBy: string): Promise<KbArticle | null> {
  const { rows } = await query<KbArticle>(
    `UPDATE kb_articles
        SET status = 'approved', approved_by = $1, approved_at = now()
      WHERE id = $2 AND tenant_id = $3
      RETURNING *`,
    [approvedBy, id, tenantId]
  );
  return rows[0] ?? null;
}

export async function archiveArticle(tenantId: string, id: string): Promise<KbArticle | null> {
  const { rows } = await query<KbArticle>(
    `UPDATE kb_articles SET status = 'archived' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function deleteArticle(tenantId: string, id: string): Promise<boolean> {
  const res = await query(`DELETE FROM kb_articles WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return res.rowCount > 0;
}

export async function incUseCount(tenantId: string, id: string): Promise<void> {
  try {
    await query(
      `UPDATE kb_articles SET use_count = use_count + 1 WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
  } catch (err) {
    logger.warn({ err, id, tenantId }, "kb.incUseCount fail");
  }
}

export async function markHelpful(tenantId: string, id: string): Promise<void> {
  try {
    await query(
      `UPDATE kb_articles SET helpful_count = helpful_count + 1 WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
  } catch (err) {
    logger.warn({ err, id, tenantId }, "kb.markHelpful fail");
  }
}

// Búsqueda simple: por sistema + ILIKE en title/problem/solution.
// Para escalas grandes, esto debería usar pgvector o full-text search.
// En MVP usamos ILIKE — suficiente para hasta unos miles de articles.
export async function searchArticles(tenantId: string, opts: {
  text: string;
  system?: string;
  limit?: number;
}): Promise<KbArticle[]> {
  const conds: string[] = ["status = 'approved'", "tenant_id = $1"];
  const params: unknown[] = [tenantId];
  if (opts.system && opts.system !== "NO_INFORMADO") {
    params.push(opts.system);
    conds.push(`(system IS NULL OR system = $${params.length})`);
  }
  if (opts.text.trim()) {
    params.push(`%${opts.text.trim()}%`);
    const p = `$${params.length}`;
    conds.push(`(title ILIKE ${p} OR problem ILIKE ${p} OR solution ILIKE ${p})`);
  }
  const limit = Math.min(opts.limit ?? 5, 20);
  params.push(limit);
  const { rows } = await query<KbArticle>(
    `SELECT * FROM kb_articles
       WHERE ${conds.join(" AND ")}
       ORDER BY helpful_count DESC, use_count DESC, created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return rows;
}
