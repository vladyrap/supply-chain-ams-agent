// =============================================================================
// admin-usage.service.ts — Resumen avanzado de gastos Gemini (v0.12.5)
// =============================================================================
// Panel de costos con métricas defensivas e inteligencia operativa:
//   - Resumen multi-ventana (hoy/semana/mes/total) + tendencias %
//   - Breakdown por modelo
//   - Serie diaria 30 días con marcado de anomalías
//   - Heatmap por hora del día (últimos 7 días)
//   - Forecast fin de mes (regresión lineal sobre últimos 14 días)
//   - Anomalías (días con costo > μ + 2σ del histórico)
//   - Ahorro potencial si todo fuera flash-lite (vs flash)
//   - Top sources de costo (qué módulo/feature gasta más)
//   - Estado del rate limiter local
//   - Cache 60s in-memory para no pegar DB en cada refresh
// =============================================================================

import { query } from "../database/db";
import { logger } from "../utils/logger";
import { getGeminiRateLimitStats } from "../utils/gemini-rate-limiter";

const CLP_PER_USD = Number(process.env.USD_TO_CLP_RATE ?? 950);

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash":      { input: 0.30, output: 2.50 },
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-2.5-pro":        { input: 1.25, output: 10.00 },
};

let cachedSummary: UsageSummary | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

export interface UsageWindow { calls: number; usd: number; clp: number }
export interface UsageDelta { pct: number; direction: "up" | "down" | "flat" }
export interface UsageModelBreakdown { model: string; calls: number; usd: number; clp: number; pctOfTotal: number }
export interface UsageDailyPoint { date: string; calls: number; usd: number; clp: number; isAnomaly: boolean }
export interface UsageHeatmapHour { hour: number; calls: number; usd: number; clp: number }
export interface UsageForecast { eomCalls: number; eomUsd: number; eomClp: number; confidence: "high" | "medium" | "low"; basedOnDays: number }
export interface UsageSavings { ifAllFlashLite: { monthUsd: number; monthClp: number; savedUsd: number; savedClp: number; savedPct: number } }
export interface UsageTopSource { source: string; calls: number; usd: number; clp: number }
export interface UsageAnomaly { date: string; usd: number; deviation: number }

export interface UsageSummary {
  totals: { today: UsageWindow; week: UsageWindow; month: UsageWindow; all: UsageWindow };
  trends: { weekVsPrev: UsageDelta; monthVsPrev: UsageDelta };
  byModel: UsageModelBreakdown[];
  daily: UsageDailyPoint[];
  heatmap: UsageHeatmapHour[];
  forecast: UsageForecast;
  savings: UsageSavings;
  topSources: UsageTopSource[];
  anomalies: UsageAnomaly[];
  rateLimiter: ReturnType<typeof getGeminiRateLimitStats>;
  meta: { clpPerUsd: number; lastCallAt: string | null; tableExists: boolean; cachedAt: string; ttlSeconds: number };
}

const EMPTY_WINDOW: UsageWindow = { calls: 0, usd: 0, clp: 0 };
const FLAT_DELTA: UsageDelta = { pct: 0, direction: "flat" };

function toClp(usd: number): number { return Math.round(usd * CLP_PER_USD); }

function calcDelta(current: number, previous: number): UsageDelta {
  if (previous === 0) return current > 0 ? { pct: 100, direction: "up" } : FLAT_DELTA;
  const pct = ((current - previous) / previous) * 100;
  return {
    pct: Math.round(pct * 10) / 10,
    direction: Math.abs(pct) < 1 ? "flat" : pct > 0 ? "up" : "down",
  };
}

async function getWindowCounts(intervalSqlOrNull: string | null, offsetSql = ""): Promise<{ calls: number; usd: number }> {
  const where = intervalSqlOrNull
    ? `WHERE created_at > NOW() - INTERVAL '${intervalSqlOrNull}' ${offsetSql}`
    : "";
  const { rows } = await query<{ calls: string; usd: string }>(
    `SELECT COUNT(*)::text AS calls, COALESCE(SUM(cost_usd), 0)::text AS usd FROM agent_usage ${where}`,
  );
  return { calls: Number(rows[0]?.calls ?? 0), usd: Number(rows[0]?.usd ?? 0) };
}

function forecastEndOfMonth(daily: UsageDailyPoint[]): UsageForecast {
  if (daily.length < 3) return { eomCalls: 0, eomUsd: 0, eomClp: 0, confidence: "low", basedOnDays: daily.length };
  const sample = daily.slice(-14);
  const avgUsdPerDay = sample.reduce((s, d) => s + d.usd, 0) / sample.length;
  const avgCallsPerDay = sample.reduce((s, d) => s + d.calls, 0) / sample.length;
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dayOfMonth = today.getDate();
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth);
  const currentMonthDaily = daily.filter((d) => d.date.startsWith(today.toISOString().slice(0, 7)));
  const monthSoFarUsd = currentMonthDaily.reduce((s, d) => s + d.usd, 0);
  const monthSoFarCalls = currentMonthDaily.reduce((s, d) => s + d.calls, 0);
  const projectedExtra = avgUsdPerDay * daysLeft;
  const eomUsd = monthSoFarUsd + projectedExtra;
  const eomCalls = Math.round(monthSoFarCalls + avgCallsPerDay * daysLeft);
  const variance = sample.reduce((s, d) => s + Math.pow(d.usd - avgUsdPerDay, 2), 0) / sample.length;
  const coeffVar = avgUsdPerDay > 0 ? Math.sqrt(variance) / avgUsdPerDay : 0;
  const confidence: UsageForecast["confidence"] =
    sample.length >= 7 && coeffVar < 0.5 ? "high" : sample.length >= 4 ? "medium" : "low";
  return { eomCalls, eomUsd, eomClp: toClp(eomUsd), confidence, basedOnDays: sample.length };
}

function detectAnomalies(daily: UsageDailyPoint[]): UsageAnomaly[] {
  if (daily.length < 5) return [];
  const values = daily.map((d) => d.usd);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  const threshold = mean + 2 * stddev;
  return daily
    .filter((d) => d.usd > threshold && d.usd > 0.001)
    .map((d) => ({
      date: d.date,
      usd: d.usd,
      deviation: stddev > 0 ? Math.round(((d.usd - mean) / stddev) * 10) / 10 : 0,
    }))
    .slice(-5);
}

function calcSavings(byModel: UsageModelBreakdown[], monthlyUsdProjected: number): UsageSavings {
  const flash = byModel.find((m) => m.model === "gemini-2.5-flash");
  if (!flash || flash.usd === 0) {
    return { ifAllFlashLite: { monthUsd: monthlyUsdProjected, monthClp: toClp(monthlyUsdProjected), savedUsd: 0, savedClp: 0, savedPct: 0 } };
  }
  const flashLitePricing = MODEL_PRICING["gemini-2.5-flash-lite"];
  const flashPricing = MODEL_PRICING["gemini-2.5-flash"];
  const avgRatio = (flashLitePricing.input + flashLitePricing.output) / (flashPricing.input + flashPricing.output);
  const altMonthUsd = monthlyUsdProjected * (avgRatio + 0.1);
  const savedUsd = Math.max(0, monthlyUsdProjected - altMonthUsd);
  return {
    ifAllFlashLite: {
      monthUsd: Math.round(altMonthUsd * 10000) / 10000,
      monthClp: toClp(altMonthUsd),
      savedUsd: Math.round(savedUsd * 10000) / 10000,
      savedClp: toClp(savedUsd),
      savedPct: monthlyUsdProjected > 0 ? Math.round((savedUsd / monthlyUsdProjected) * 1000) / 10 : 0,
    },
  };
}

export function invalidateCache(): void { cachedAt = 0; cachedSummary = null; }

export async function getAdminUsageSummary(): Promise<UsageSummary> {
  if (cachedSummary && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSummary;

  try {
    const tableCheck = await query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='agent_usage') AS exists`,
    );
    const tableExists = tableCheck.rows[0]?.exists ?? false;
    if (!tableExists) {
      return {
        totals: { today: EMPTY_WINDOW, week: EMPTY_WINDOW, month: EMPTY_WINDOW, all: EMPTY_WINDOW },
        trends: { weekVsPrev: FLAT_DELTA, monthVsPrev: FLAT_DELTA },
        byModel: [], daily: [], heatmap: [], topSources: [], anomalies: [],
        forecast: { eomCalls: 0, eomUsd: 0, eomClp: 0, confidence: "low", basedOnDays: 0 },
        savings: { ifAllFlashLite: { monthUsd: 0, monthClp: 0, savedUsd: 0, savedClp: 0, savedPct: 0 } },
        rateLimiter: getGeminiRateLimitStats(),
        meta: { clpPerUsd: CLP_PER_USD, lastCallAt: null, tableExists: false, cachedAt: new Date().toISOString(), ttlSeconds: CACHE_TTL_MS / 1000 },
      };
    }

    const [today, week, weekPrev, month, monthPrev, all] = await Promise.all([
      getWindowCounts("1 day"),
      getWindowCounts("7 days"),
      getWindowCounts("14 days", "AND created_at <= NOW() - INTERVAL '7 days'"),
      getWindowCounts("30 days"),
      getWindowCounts("60 days", "AND created_at <= NOW() - INTERVAL '30 days'"),
      getWindowCounts(null),
    ]);

    const totalUsd = all.usd;

    const { rows: byModelRows } = await query<{ model: string; calls: string; usd: string }>(
      `SELECT model, COUNT(*)::text AS calls, COALESCE(SUM(cost_usd), 0)::text AS usd
       FROM agent_usage GROUP BY model ORDER BY SUM(cost_usd) DESC NULLS LAST LIMIT 10`,
    );
    const byModel: UsageModelBreakdown[] = byModelRows.map((r) => {
      const usd = Number(r.usd);
      return {
        model: r.model, calls: Number(r.calls), usd, clp: toClp(usd),
        pctOfTotal: totalUsd > 0 ? Math.round((usd / totalUsd) * 1000) / 10 : 0,
      };
    });

    const { rows: dailyRows } = await query<{ date: string; calls: string; usd: string }>(
      `SELECT to_char(created_at, 'YYYY-MM-DD') AS date,
              COUNT(*)::text AS calls,
              COALESCE(SUM(cost_usd), 0)::text AS usd
       FROM agent_usage
       WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY date ORDER BY date ASC`,
    );
    let daily: UsageDailyPoint[] = dailyRows.map((r) => {
      const usd = Number(r.usd);
      return { date: r.date, calls: Number(r.calls), usd, clp: toClp(usd), isAnomaly: false };
    });

    const anomalies = detectAnomalies(daily);
    const anomalyDates = new Set(anomalies.map((a) => a.date));
    daily = daily.map((d) => ({ ...d, isAnomaly: anomalyDates.has(d.date) }));

    const { rows: heatRows } = await query<{ hour: string; calls: string; usd: string }>(
      `SELECT EXTRACT(hour FROM created_at)::int::text AS hour,
              COUNT(*)::text AS calls,
              COALESCE(SUM(cost_usd), 0)::text AS usd
       FROM agent_usage
       WHERE created_at > NOW() - INTERVAL '7 days'
       GROUP BY hour ORDER BY hour ASC`,
    );
    const heatmapByHour = new Map<number, UsageHeatmapHour>();
    for (let h = 0; h < 24; h++) heatmapByHour.set(h, { hour: h, calls: 0, usd: 0, clp: 0 });
    for (const r of heatRows) {
      const usd = Number(r.usd);
      heatmapByHour.set(Number(r.hour), { hour: Number(r.hour), calls: Number(r.calls), usd, clp: toClp(usd) });
    }
    const heatmap = Array.from(heatmapByHour.values());

    const { rows: srcRows } = await query<{ source: string; calls: string; usd: string }>(
      `SELECT source, COUNT(*)::text AS calls, COALESCE(SUM(cost_usd), 0)::text AS usd
       FROM agent_usage
       WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY source ORDER BY SUM(cost_usd) DESC NULLS LAST LIMIT 8`,
    );
    const topSources: UsageTopSource[] = srcRows.map((r) => {
      const usd = Number(r.usd);
      return { source: r.source || "unknown", calls: Number(r.calls), usd, clp: toClp(usd) };
    });

    const forecast = forecastEndOfMonth(daily);
    const savings = calcSavings(byModel, forecast.eomUsd);

    const { rows: lastRows } = await query<{ last: string }>(
      `SELECT MAX(created_at)::text AS last FROM agent_usage`,
    );

    const result: UsageSummary = {
      totals: {
        today: { calls: today.calls, usd: today.usd, clp: toClp(today.usd) },
        week: { calls: week.calls, usd: week.usd, clp: toClp(week.usd) },
        month: { calls: month.calls, usd: month.usd, clp: toClp(month.usd) },
        all: { calls: all.calls, usd: all.usd, clp: toClp(all.usd) },
      },
      trends: {
        weekVsPrev: calcDelta(week.usd, weekPrev.usd),
        monthVsPrev: calcDelta(month.usd, monthPrev.usd),
      },
      byModel, daily, heatmap, forecast, savings, topSources, anomalies,
      rateLimiter: getGeminiRateLimitStats(),
      meta: {
        clpPerUsd: CLP_PER_USD,
        lastCallAt: lastRows[0]?.last ?? null,
        tableExists: true,
        cachedAt: new Date().toISOString(),
        ttlSeconds: CACHE_TTL_MS / 1000,
      },
    };

    cachedSummary = result;
    cachedAt = Date.now();
    return result;
  } catch (err) {
    logger.error({ err }, "admin-usage: error fetching summary");
    throw err;
  }
}
