// Servicio de feedback humano sobre respuestas del agente.
// Captura 👍/👎 por respuesta con contexto (query original, respuesta, fuentes)
// para usar después en Agent Lab y mejorar prompts/KB.

import { query } from "../database/db";
import { logger } from "../utils/logger";

export type FeedbackSource = "support" | "agent_chat" | "voice" | "other";
export type FeedbackKind = "positive" | "negative";

export interface AiFeedbackRow {
  id: string;
  source: FeedbackSource;
  kind: FeedbackKind;
  reason: string | null;
  conversation_id: string | null;
  message_id: string | null;
  ticket_id: string | null;
  query: string | null;
  response: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

export interface CreateFeedbackInput {
  source: FeedbackSource;
  kind: FeedbackKind;
  reason?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  ticketId?: string | null;
  query?: string | null;
  response?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}

// Ensure schema lazy (idempotente, por si DB es nueva)
let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS ai_response_feedback (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source          TEXT NOT NULL CHECK (source IN ('support','agent_chat','voice','other')),
        kind            TEXT NOT NULL CHECK (kind IN ('positive','negative')),
        reason          TEXT,
        conversation_id UUID,
        message_id      UUID,
        ticket_id       UUID,
        query           TEXT,
        response        TEXT,
        metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by      UUID,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_ai_resp_fb_created ON ai_response_feedback (created_at DESC);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ai_resp_fb_kind    ON ai_response_feedback (kind);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ai_resp_fb_conv    ON ai_response_feedback (conversation_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ai_resp_fb_source  ON ai_response_feedback (source);`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure ai_response_feedback schema failed");
  }
}

export async function createFeedback(input: CreateFeedbackInput): Promise<AiFeedbackRow> {
  await ensureSchema();
  const { rows } = await query<AiFeedbackRow>(
    `
    INSERT INTO ai_response_feedback
      (source, kind, reason, conversation_id, message_id, ticket_id, query, response, metadata, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
    RETURNING *
    `,
    [
      input.source,
      input.kind,
      input.reason ?? null,
      input.conversationId ?? null,
      input.messageId ?? null,
      input.ticketId ?? null,
      input.query ?? null,
      input.response ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdBy ?? null,
    ]
  );
  return rows[0];
}

export interface ListFeedbackFilters {
  source?: FeedbackSource;
  kind?: FeedbackKind;
  conversationId?: string;
  limit?: number;
  fromDate?: string;
}

export async function listFeedback(filters: ListFeedbackFilters = {}): Promise<AiFeedbackRow[]> {
  await ensureSchema();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.source) {
    params.push(filters.source);
    conds.push(`source = $${params.length}`);
  }
  if (filters.kind) {
    params.push(filters.kind);
    conds.push(`kind = $${params.length}`);
  }
  if (filters.conversationId) {
    params.push(filters.conversationId);
    conds.push(`conversation_id = $${params.length}`);
  }
  if (filters.fromDate) {
    params.push(filters.fromDate);
    conds.push(`created_at >= $${params.length}`);
  }
  const safeLimit = Math.max(1, Math.min(500, filters.limit ?? 100));
  params.push(safeLimit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT * FROM ai_response_feedback
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY created_at DESC
    LIMIT ${limitParam}
  `;
  const { rows } = await query<AiFeedbackRow>(sql, params);
  return rows;
}

export interface FeedbackStats {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
  bySource: { source: string; positive: number; negative: number }[];
  recent7d: number;
}

export async function getFeedbackStats(): Promise<FeedbackStats> {
  await ensureSchema();
  const { rows: tot } = await query<{ total: string; positive: string; negative: string; recent7d: string }>(
    `
    SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE kind = 'positive')::text AS positive,
      count(*) FILTER (WHERE kind = 'negative')::text AS negative,
      count(*) FILTER (WHERE created_at > now() - interval '7 days')::text AS recent7d
    FROM ai_response_feedback
    `
  );
  const { rows: bySource } = await query<{ source: string; positive: string; negative: string }>(
    `
    SELECT source,
           count(*) FILTER (WHERE kind = 'positive')::text AS positive,
           count(*) FILTER (WHERE kind = 'negative')::text AS negative
    FROM ai_response_feedback
    GROUP BY source
    `
  );
  const total    = Number(tot[0]?.total ?? 0);
  const positive = Number(tot[0]?.positive ?? 0);
  const negative = Number(tot[0]?.negative ?? 0);
  return {
    total, positive, negative,
    positiveRate: total > 0 ? Math.round((positive / total) * 100) : 0,
    recent7d: Number(tot[0]?.recent7d ?? 0),
    bySource: bySource.map((r) => ({
      source: r.source,
      positive: Number(r.positive),
      negative: Number(r.negative),
    })),
  };
}
