// Tracking de uso real de Gemini.
// La SDK devuelve `response.usageMetadata` con prompt/completion/total tokens.
// Después de cada llamada, recordUsageFireAndForget() persiste el evento
// con costo calculado según pricing público del modelo.

import { query } from "../database/db";
import { logger } from "../utils/logger";

// USD por 1M tokens (input/output). Pricing público Gemini (2025-2026).
// Si el modelo no está en la tabla, usa DEFAULT_PRICING.
const PRICING: Record<string, { in: number; out: number }> = {
  "gemini-2.5-pro":         { in: 1.25,  out: 10.00 },
  "gemini-2.5-flash":       { in: 0.30,  out: 2.50  },
  "gemini-2.5-flash-lite":  { in: 0.10,  out: 0.40  },
  "gemini-1.5-pro":         { in: 1.25,  out: 5.00  },
  "gemini-1.5-flash":       { in: 0.075, out: 0.30  },
  "gemini-embedding-001":   { in: 0.025, out: 0     },
};
const DEFAULT_PRICING = { in: 0.10, out: 0.40 };

export type UsageSource =
  | "chat" | "research" | "triage" | "resolver" | "eval" | "ingest" | "embedding" | "other";

export interface UsageRecord {
  source: UsageSource;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  incidentId?: string | null;
  conversationId?: string | null;
  metadata?: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractUsage(resp: any): {
  promptTokens: number; completionTokens: number; totalTokens: number;
} {
  const u = resp?.usageMetadata ?? resp?.response?.usageMetadata;
  return {
    promptTokens:     u?.promptTokenCount     ?? 0,
    completionTokens: u?.candidatesTokenCount ?? 0,
    totalTokens:      u?.totalTokenCount      ?? 0,
  };
}

function priceFor(model: string): { in: number; out: number } {
  // Quitar sufijos como "+kb-fallback"
  const base = model.split(/[+\s]/)[0].trim();
  return PRICING[base] ?? DEFAULT_PRICING;
}

export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model);
  const cost = (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
  return Math.round(cost * 1e8) / 1e8; // 8 decimales (lo que aguanta la columna)
}

export async function recordUsage(rec: UsageRecord): Promise<void> {
  try {
    const prompt = rec.promptTokens ?? 0;
    const completion = rec.completionTokens ?? 0;
    const total = rec.totalTokens ?? (prompt + completion);
    if (total === 0) return; // nada que registrar
    const cost = costUsd(rec.model, prompt, completion);
    await query(
      `INSERT INTO agent_usage
         (source, model, prompt_tokens, completion_tokens, total_tokens,
          cost_usd, incident_id, conversation_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        rec.source, rec.model, prompt, completion, total, cost,
        rec.incidentId ?? null, rec.conversationId ?? null,
        JSON.stringify(rec.metadata ?? {}),
      ]
    );
  } catch (err) {
    logger.warn({ err }, "usage.record fail (non-blocking)");
  }
}

export function recordUsageFireAndForget(rec: UsageRecord): void {
  recordUsage(rec).catch(() => undefined);
}

// ============================================================
// Lectura: summary para dashboard
// ============================================================

export interface UsageSummary {
  period: { from: string; to: string; days: number };
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number };
  byModel:  { model: string;  calls: number; tokens: number; costUsd: number }[];
  bySource: { source: string; calls: number; tokens: number; costUsd: number }[];
  byDay:    { day: string;    calls: number; tokens: number; costUsd: number }[];
}

export async function getUsageSummary(days = 30): Promise<UsageSummary> {
  const safeDays = Math.max(1, Math.min(days, 365));
  const interval = `${safeDays} days`;

  const [totalsRow, byModelRows, bySourceRows, byDayRows] = await Promise.all([
    query<{ calls: string; pt: string; ct: string; tt: string; cost: string }>(
      `SELECT count(*)::text AS calls,
              COALESCE(sum(prompt_tokens),0)::text     AS pt,
              COALESCE(sum(completion_tokens),0)::text AS ct,
              COALESCE(sum(total_tokens),0)::text      AS tt,
              COALESCE(sum(cost_usd),0)::text          AS cost
         FROM agent_usage WHERE created_at >= now() - interval '${interval}'`
    ),
    query<{ model: string; calls: string; tokens: string; cost: string }>(
      `SELECT model, count(*)::text AS calls,
              COALESCE(sum(total_tokens),0)::text AS tokens,
              COALESCE(sum(cost_usd),0)::text     AS cost
         FROM agent_usage WHERE created_at >= now() - interval '${interval}'
        GROUP BY model ORDER BY sum(cost_usd) DESC`
    ),
    query<{ source: string; calls: string; tokens: string; cost: string }>(
      `SELECT source, count(*)::text AS calls,
              COALESCE(sum(total_tokens),0)::text AS tokens,
              COALESCE(sum(cost_usd),0)::text     AS cost
         FROM agent_usage WHERE created_at >= now() - interval '${interval}'
        GROUP BY source ORDER BY sum(cost_usd) DESC`
    ),
    query<{ d: string; calls: string; tokens: string; cost: string }>(
      `WITH days AS (
         SELECT generate_series(
           current_date - interval '${safeDays - 1} days', current_date, interval '1 day'
         )::date AS day
       )
       SELECT d.day::text AS d,
              COALESCE(count(au.id),0)::text                    AS calls,
              COALESCE(sum(au.total_tokens),0)::text            AS tokens,
              COALESCE(sum(au.cost_usd),0)::text                AS cost
         FROM days d
         LEFT JOIN agent_usage au ON au.created_at::date = d.day
        GROUP BY d.day ORDER BY d.day`
    ),
  ]);

  const t = totalsRow.rows[0];
  const now = new Date();
  const from = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);

  return {
    period: { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), days: safeDays },
    totals: {
      calls:             Number(t?.calls ?? 0),
      promptTokens:      Number(t?.pt    ?? 0),
      completionTokens:  Number(t?.ct    ?? 0),
      totalTokens:       Number(t?.tt    ?? 0),
      costUsd:           Number(t?.cost  ?? 0),
    },
    byModel:  byModelRows.rows.map((r)  => ({ model:  r.model,  calls: Number(r.calls), tokens: Number(r.tokens), costUsd: Number(r.cost) })),
    bySource: bySourceRows.rows.map((r) => ({ source: r.source, calls: Number(r.calls), tokens: Number(r.tokens), costUsd: Number(r.cost) })),
    byDay:    byDayRows.rows.map((r)    => ({ day:    r.d,      calls: Number(r.calls), tokens: Number(r.tokens), costUsd: Number(r.cost) })),
  };
}
