// =============================================================================
// admin-usage.service.ts — Resumen de gastos Gemini (v0.12.4)
// =============================================================================
// Calcula gasto del agente para el panel /admin/costs en el platform.
// Lee de tabla agent_usage (existente) que registra cada call con cost_usd.
//
// Devuelve resumen multi-ventana + breakdown por modelo + serie diaria
// + estado del rate limiter local.
// =============================================================================

import { query } from "../database/db";
import { logger } from "../utils/logger";
import { getGeminiRateLimitStats } from "../utils/gemini-rate-limiter";

const CLP_PER_USD = Number(process.env.USD_TO_CLP_RATE ?? 950);

export interface UsageSummary {
  totals: {
    today: { calls: number; usd: number; clp: number };
    week: { calls: number; usd: number; clp: number };
    month: { calls: number; usd: number; clp: number };
    all: { calls: number; usd: number; clp: number };
  };
  byModel: { model: string; calls: number; usd: number; clp: number }[];
  daily: { date: string; calls: number; usd: number; clp: number }[];
  rateLimiter: ReturnType<typeof getGeminiRateLimitStats>;
  meta: { clpPerUsd: number; lastCallAt: string | null; tableExists: boolean };
}

const EMPTY_WINDOW = { calls: 0, usd: 0, clp: 0 };

async function getWindow(intervalSql: string | null): Promise<{ calls: number; usd: number }> {
  const whereClause = intervalSql ? `WHERE created_at > NOW() - INTERVAL '${intervalSql}'` : "";
  const { rows } = await query<{ calls: string; usd: string }>(
    `SELECT COUNT(*)::text AS calls, COALESCE(SUM(cost_usd), 0)::text AS usd
     FROM agent_usage ${whereClause}`,
  );
  return {
    calls: Number(rows[0]?.calls ?? 0),
    usd: Number(rows[0]?.usd ?? 0),
  };
}

function toClp(usd: number): number {
  return Math.round(usd * CLP_PER_USD);
}

export async function getAdminUsageSummary(): Promise<UsageSummary> {
  try {
    // Verificar que la tabla existe (best-effort)
    const tableCheck = await query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='agent_usage') AS exists`,
    );
    const tableExists = tableCheck.rows[0]?.exists ?? false;
    if (!tableExists) {
      logger.warn("admin-usage: agent_usage table no existe — devolviendo empty");
      return {
        totals: { today: EMPTY_WINDOW, week: EMPTY_WINDOW, month: EMPTY_WINDOW, all: EMPTY_WINDOW },
        byModel: [],
        daily: [],
        rateLimiter: getGeminiRateLimitStats(),
        meta: { clpPerUsd: CLP_PER_USD, lastCallAt: null, tableExists: false },
      };
    }

    // 4 ventanas en paralelo
    const [today, week, month, all] = await Promise.all([
      getWindow("1 day"),
      getWindow("7 days"),
      getWindow("30 days"),
      getWindow(null),
    ]);

    // Breakdown por modelo (top 10)
    const { rows: byModelRows } = await query<{ model: string; calls: string; usd: string }>(
      `SELECT model, COUNT(*)::text AS calls, COALESCE(SUM(cost_usd), 0)::text AS usd
       FROM agent_usage
       GROUP BY model
       ORDER BY SUM(cost_usd) DESC NULLS LAST
       LIMIT 10`,
    );

    // Serie diaria últimos 30 días
    const { rows: dailyRows } = await query<{ date: string; calls: string; usd: string }>(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS date,
              COUNT(*)::text AS calls,
              COALESCE(SUM(cost_usd), 0)::text AS usd
       FROM agent_usage
       WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY date
       ORDER BY date ASC`,
    );

    // Última call (para indicar "freshness" en UI)
    const { rows: lastRows } = await query<{ last: string }>(
      `SELECT MAX(created_at)::text AS last FROM agent_usage`,
    );

    return {
      totals: {
        today: { calls: today.calls, usd: today.usd, clp: toClp(today.usd) },
        week: { calls: week.calls, usd: week.usd, clp: toClp(week.usd) },
        month: { calls: month.calls, usd: month.usd, clp: toClp(month.usd) },
        all: { calls: all.calls, usd: all.usd, clp: toClp(all.usd) },
      },
      byModel: byModelRows.map((r) => {
        const usd = Number(r.usd);
        return { model: r.model, calls: Number(r.calls), usd, clp: toClp(usd) };
      }),
      daily: dailyRows.map((r) => {
        const usd = Number(r.usd);
        return { date: r.date, calls: Number(r.calls), usd, clp: toClp(usd) };
      }),
      rateLimiter: getGeminiRateLimitStats(),
      meta: {
        clpPerUsd: CLP_PER_USD,
        lastCallAt: lastRows[0]?.last ?? null,
        tableExists: true,
      },
    };
  } catch (err) {
    logger.error({ err }, "admin-usage: error fetching summary");
    throw err;
  }
}
