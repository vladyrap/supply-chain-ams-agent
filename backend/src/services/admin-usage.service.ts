// =============================================================================
// admin-usage.service.ts — Dashboard ULTIMATE de costos (v0.12.6)
// =============================================================================
// Telemetría operacional + IA predictiva + recomendaciones accionables:
//   v0.12.5 features (mantenidas):
//     - Multi-ventana, tendencias %, byModel, daily, heatmap, forecast,
//       anomalies, savings, topSources, rate limiter
//   v0.12.6 NUEVO:
//     - Health score 0-100 con descomposición por dimensión
//     - Recommendations engine (sugerencias accionables auto)
//     - Burn rate hora actual vs hora previa
//     - Same-day-last-week comparison (¿gastás más que el lunes pasado?)
//     - Token breakdown (input vs output con costo y %)
//     - Cost distribution histogram (5 buckets micro→large)
//     - Cache 60s in-memory
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

// ===== Types =====
export interface UsageWindow { calls: number; usd: number; clp: number }
export interface UsageDelta { pct: number; direction: "up" | "down" | "flat" }
export interface UsageModelBreakdown { model: string; calls: number; usd: number; clp: number; pctOfTotal: number }
export interface UsageDailyPoint { date: string; calls: number; usd: number; clp: number; isAnomaly: boolean }
export interface UsageHeatmapHour { hour: number; calls: number; usd: number; clp: number }
export interface UsageForecast { eomCalls: number; eomUsd: number; eomClp: number; confidence: "high" | "medium" | "low"; basedOnDays: number }
export interface UsageSavings { ifAllFlashLite: { monthUsd: number; monthClp: number; savedUsd: number; savedClp: number; savedPct: number } }
export interface UsageTopSource { source: string; calls: number; usd: number; clp: number }
export interface UsageAnomaly { date: string; usd: number; deviation: number }

// NUEVOS v0.12.6
export interface UsageTokens { input: number; output: number; total: number; inputUsd: number; outputUsd: number; inputPct: number; outputPct: number }
export interface UsageBurnRate { lastHourCalls: number; lastHourUsd: number; prevHourCalls: number; deltaPct: number; estimateNext24hUsd: number; estimateNext24hClp: number }
export interface UsageHistogram { bucket: string; minUsd: number; calls: number; pct: number }
export interface UsageHealth {
  score: number;
  status: "excellent" | "good" | "watch" | "warning" | "critical";
  dimensions: { name: string; score: number; weight: number; reason: string }[];
}
export interface UsageRecommendation {
  id: string;
  priority: "high" | "medium" | "low";
  category: "savings" | "performance" | "safety" | "ops";
  title: string;
  description: string;
  estimatedSavingClp?: number;
  actionable: boolean;
}
export interface UsageSameDayComparison {
  today: { calls: number; usd: number; clp: number };
  sameDayLastWeek: { calls: number; usd: number; clp: number; date: string };
  delta: UsageDelta;
}

export interface UsageRateLimiterStats {
  enabled: boolean;
  caps: { minute: number; hour: number; day: number };
  current: { minute: number; hour: number; day: number };
  remaining: { minute: number; hour: number; day: number };
}

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
  rateLimiter: UsageRateLimiterStats;
  // NUEVOS v0.12.6:
  tokens: UsageTokens;
  burnRate: UsageBurnRate;
  histogram: UsageHistogram[];
  health: UsageHealth;
  recommendations: UsageRecommendation[];
  sameDayLastWeek: UsageSameDayComparison;
  meta: { clpPerUsd: number; lastCallAt: string | null; tableExists: boolean; cachedAt: string; ttlSeconds: number; version: string };
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
  const daysLeft = Math.max(0, daysInMonth - today.getDate());
  const currentMonthDaily = daily.filter((d) => d.date.startsWith(today.toISOString().slice(0, 7)));
  const monthSoFarUsd = currentMonthDaily.reduce((s, d) => s + d.usd, 0);
  const monthSoFarCalls = currentMonthDaily.reduce((s, d) => s + d.calls, 0);
  const eomUsd = monthSoFarUsd + avgUsdPerDay * daysLeft;
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
  const fl = MODEL_PRICING["gemini-2.5-flash-lite"];
  const fp = MODEL_PRICING["gemini-2.5-flash"];
  const avgRatio = (fl.input + fl.output) / (fp.input + fp.output);
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

// ===== v0.12.6 NUEVOS HELPERS =====

async function getTokens(): Promise<UsageTokens> {
  const { rows } = await query<{ input: string; output: string; input_usd: string; output_usd: string }>(`
    SELECT
      COALESCE(SUM(prompt_tokens), 0)::text AS input,
      COALESCE(SUM(completion_tokens), 0)::text AS output,
      COALESCE(SUM(
        prompt_tokens * COALESCE((CASE
          WHEN model = 'gemini-2.5-flash' THEN 0.30
          WHEN model = 'gemini-2.5-flash-lite' THEN 0.10
          WHEN model = 'gemini-2.5-pro' THEN 1.25
          ELSE 0.30
        END) / 1000000, 0)
      ), 0)::text AS input_usd,
      COALESCE(SUM(
        completion_tokens * COALESCE((CASE
          WHEN model = 'gemini-2.5-flash' THEN 2.50
          WHEN model = 'gemini-2.5-flash-lite' THEN 0.40
          WHEN model = 'gemini-2.5-pro' THEN 10.00
          ELSE 2.50
        END) / 1000000, 0)
      ), 0)::text AS output_usd
    FROM agent_usage
  `);
  const input = Number(rows[0]?.input ?? 0);
  const output = Number(rows[0]?.output ?? 0);
  const total = input + output;
  const inputUsd = Number(rows[0]?.input_usd ?? 0);
  const outputUsd = Number(rows[0]?.output_usd ?? 0);
  const sumUsd = inputUsd + outputUsd;
  return {
    input, output, total, inputUsd, outputUsd,
    inputPct: sumUsd > 0 ? Math.round((inputUsd / sumUsd) * 1000) / 10 : 0,
    outputPct: sumUsd > 0 ? Math.round((outputUsd / sumUsd) * 1000) / 10 : 0,
  };
}

async function getBurnRate(): Promise<UsageBurnRate> {
  const { rows } = await query<{ last_calls: string; last_usd: string; prev_calls: string }>(`
    SELECT
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::text AS last_calls,
      COALESCE(SUM(cost_usd) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour'), 0)::text AS last_usd,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '2 hour' AND created_at <= NOW() - INTERVAL '1 hour')::text AS prev_calls
    FROM agent_usage
  `);
  const lastHourCalls = Number(rows[0]?.last_calls ?? 0);
  const lastHourUsd = Number(rows[0]?.last_usd ?? 0);
  const prevHourCalls = Number(rows[0]?.prev_calls ?? 0);
  const delta = calcDelta(lastHourCalls, prevHourCalls);
  const estimateNext24hUsd = lastHourUsd * 24;
  return {
    lastHourCalls, lastHourUsd, prevHourCalls,
    deltaPct: delta.pct,
    estimateNext24hUsd: Math.round(estimateNext24hUsd * 10000) / 10000,
    estimateNext24hClp: toClp(estimateNext24hUsd),
  };
}

async function getHistogram(): Promise<UsageHistogram[]> {
  const { rows } = await query<{ bucket: string; min_usd: string; calls: string }>(`
    SELECT bucket, MIN(cost_usd)::text AS min_usd, COUNT(*)::text AS calls FROM (
      SELECT cost_usd,
        CASE
          WHEN cost_usd < 0.0005 THEN 'micro'
          WHEN cost_usd < 0.001 THEN 'tiny'
          WHEN cost_usd < 0.002 THEN 'small'
          WHEN cost_usd < 0.005 THEN 'medium'
          ELSE 'large'
        END AS bucket
      FROM agent_usage
    ) sub
    GROUP BY bucket
    ORDER BY MIN(cost_usd) ASC
  `);
  const total = rows.reduce((s, r) => s + Number(r.calls), 0);
  return rows.map((r) => ({
    bucket: r.bucket,
    minUsd: Number(r.min_usd),
    calls: Number(r.calls),
    pct: total > 0 ? Math.round((Number(r.calls) / total) * 1000) / 10 : 0,
  }));
}

async function getSameDayLastWeek(today: UsageWindow): Promise<UsageSameDayComparison> {
  const { rows } = await query<{ calls: string; usd: string; date: string }>(`
    SELECT
      COUNT(*)::text AS calls,
      COALESCE(SUM(cost_usd), 0)::text AS usd,
      to_char(NOW() - INTERVAL '7 days', 'YYYY-MM-DD') AS date
    FROM agent_usage
    WHERE created_at::date = (NOW() - INTERVAL '7 days')::date
  `);
  const sameUsd = Number(rows[0]?.usd ?? 0);
  return {
    today: { calls: today.calls, usd: today.usd, clp: toClp(today.usd) },
    sameDayLastWeek: {
      calls: Number(rows[0]?.calls ?? 0),
      usd: sameUsd,
      clp: toClp(sameUsd),
      date: rows[0]?.date ?? "",
    },
    delta: calcDelta(today.usd, sameUsd),
  };
}

function calcHealth(opts: {
  rateLimiterDayPct: number;
  forecastConfidence: UsageForecast["confidence"];
  anomaliesCount: number;
  monthVsPrevDirection: UsageDelta["direction"];
  flashPctOfTotal: number;
}): UsageHealth {
  const dims: UsageHealth["dimensions"] = [];

  // Dim 1: Rate limiter headroom (40%)
  const headroom = 100 - opts.rateLimiterDayPct;
  const rlScore = Math.max(0, Math.min(100, headroom));
  dims.push({
    name: "Rate Limiter",
    score: Math.round(rlScore),
    weight: 0.4,
    reason: `${Math.round(opts.rateLimiterDayPct)}% del cap diario consumido`,
  });

  // Dim 2: Forecast confidence (20%)
  const fcScore = opts.forecastConfidence === "high" ? 100 : opts.forecastConfidence === "medium" ? 70 : 40;
  dims.push({
    name: "Predictibilidad",
    score: fcScore,
    weight: 0.2,
    reason: `Forecast con confidence ${opts.forecastConfidence}`,
  });

  // Dim 3: Anomaly count (20%)
  const anomScore = Math.max(0, 100 - opts.anomaliesCount * 25);
  dims.push({
    name: "Estabilidad",
    score: anomScore,
    weight: 0.2,
    reason: opts.anomaliesCount === 0 ? "Sin anomalías" : `${opts.anomaliesCount} días anómalos detectados`,
  });

  // Dim 4: Trend control (10%)
  const trScore = opts.monthVsPrevDirection === "down" ? 100 : opts.monthVsPrevDirection === "flat" ? 80 : 50;
  dims.push({
    name: "Tendencia",
    score: trScore,
    weight: 0.1,
    reason: opts.monthVsPrevDirection === "down"
      ? "Gasto bajando vs mes anterior"
      : opts.monthVsPrevDirection === "flat"
        ? "Gasto estable vs mes anterior"
        : "Gasto subiendo vs mes anterior",
  });

  // Dim 5: Cost efficiency (10%)
  const eff = opts.flashPctOfTotal > 70 ? 50 : opts.flashPctOfTotal > 40 ? 75 : 95;
  dims.push({
    name: "Eficiencia",
    score: eff,
    weight: 0.1,
    reason: opts.flashPctOfTotal > 70
      ? "Mucho consumo de flash (caro)"
      : "Mix de modelos eficiente",
  });

  const score = Math.round(dims.reduce((s, d) => s + d.score * d.weight, 0));
  const status: UsageHealth["status"] =
    score >= 90 ? "excellent" :
    score >= 75 ? "good" :
    score >= 60 ? "watch" :
    score >= 40 ? "warning" : "critical";

  return { score, status, dimensions: dims };
}

function buildRecommendations(opts: {
  savings: UsageSavings;
  rateLimiterDayPct: number;
  forecast: UsageForecast;
  anomalies: UsageAnomaly[];
  monthDelta: UsageDelta;
  flashPctOfTotal: number;
  burnRate: UsageBurnRate;
}): UsageRecommendation[] {
  const recs: UsageRecommendation[] = [];

  // High priority: savings potential significativo
  if (opts.savings.ifAllFlashLite.savedClp > 1000 && opts.flashPctOfTotal > 60) {
    recs.push({
      id: "switch-to-flash-lite",
      priority: "high",
      category: "savings",
      title: `Ahorrar CLP ${opts.savings.ifAllFlashLite.savedClp.toLocaleString("es-CL")}/mes pasando tareas no críticas a flash-lite`,
      description: `${opts.flashPctOfTotal}% de tu gasto es flash (caro). Para tareas como classificación o triage que no necesitan razonamiento complejo, flash-lite cuesta 3-4x menos y la calidad es suficiente.`,
      estimatedSavingClp: opts.savings.ifAllFlashLite.savedClp,
      actionable: true,
    });
  }

  // High priority: rate limiter cerca del cap
  if (opts.rateLimiterDayPct > 80) {
    recs.push({
      id: "near-rate-cap",
      priority: "high",
      category: "safety",
      title: `Rate limiter al ${Math.round(opts.rateLimiterDayPct)}% del cap diario`,
      description: `Considerá aumentar GEMINI_CAP_PER_DAY o bajar el ritmo de calls. Si excedés el cap, el sistema bloquea nuevas llamadas hasta el reset diario.`,
      actionable: true,
    });
  }

  // Medium: anomalías recientes
  if (opts.anomalies.length > 0) {
    const last = opts.anomalies[opts.anomalies.length - 1];
    recs.push({
      id: "investigate-anomalies",
      priority: "medium",
      category: "ops",
      title: `${opts.anomalies.length} día(s) con gasto anómalo detectado`,
      description: `El día ${last.date} tuvo costo ${last.deviation}σ sobre el promedio. Revisar si hubo bug, loop o uso legítimo no esperado.`,
      actionable: true,
    });
  }

  // Medium: tendencia subiendo significativamente
  if (opts.monthDelta.direction === "up" && opts.monthDelta.pct > 50) {
    recs.push({
      id: "month-trending-up",
      priority: "medium",
      category: "ops",
      title: `Gasto del mes +${opts.monthDelta.pct}% vs mes pasado`,
      description: `El consumo viene creciendo agresivamente. Revisar si es por más uso legítimo o por algún proceso descontrolado.`,
      actionable: true,
    });
  }

  // Medium: forecast indica posible problema
  if (opts.forecast.confidence === "high" && opts.forecast.eomClp > 5000) {
    recs.push({
      id: "forecast-warning",
      priority: "medium",
      category: "savings",
      title: `Forecast fin de mes: CLP ${opts.forecast.eomClp.toLocaleString("es-CL")}`,
      description: `Si el patrón actual sigue, gastarías ${(opts.forecast.eomUsd).toFixed(2)} USD este mes. Considerá bajar caps o cambiar modelo si excede tu budget.`,
      actionable: true,
    });
  }

  // Low: burn rate alto en última hora
  if (opts.burnRate.lastHourCalls > 50) {
    recs.push({
      id: "high-burn-rate",
      priority: "low",
      category: "performance",
      title: `Burn rate alto: ${opts.burnRate.lastHourCalls} calls última hora`,
      description: `A este ritmo serían ~${opts.burnRate.estimateNext24hClp.toLocaleString("es-CL")} CLP/día. Normal si hay demo o uso intensivo.`,
      actionable: false,
    });
  }

  // Si no hay ninguna recomendación crítica, agregar info positiva
  if (recs.length === 0) {
    recs.push({
      id: "all-good",
      priority: "low",
      category: "ops",
      title: "✓ Sistema operando dentro de parámetros normales",
      description: "Sin anomalías, sin alertas de cap, tendencia controlada. Mantener monitoreo.",
      actionable: false,
    });
  }

  return recs.slice(0, 6);
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
      return buildEmpty();
    }

    const [today, week, weekPrev, month, monthPrev, all, tokens, burnRate, histogram] = await Promise.all([
      getWindowCounts("1 day"),
      getWindowCounts("7 days"),
      getWindowCounts("14 days", "AND created_at <= NOW() - INTERVAL '7 days'"),
      getWindowCounts("30 days"),
      getWindowCounts("60 days", "AND created_at <= NOW() - INTERVAL '30 days'"),
      getWindowCounts(null),
      getTokens(),
      getBurnRate(),
      getHistogram(),
    ]);

    const totalUsd = all.usd;
    const todayWindow: UsageWindow = { calls: today.calls, usd: today.usd, clp: toClp(today.usd) };
    const sameDayLastWeek = await getSameDayLastWeek(todayWindow);

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
    const flashPctOfTotal = byModel.find((m) => m.model === "gemini-2.5-flash")?.pctOfTotal ?? 0;

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

    const rateLimiter = getGeminiRateLimitStats();
    const rateLimiterDayPct = (rateLimiter.current.day / rateLimiter.caps.day) * 100;

    const trends = {
      weekVsPrev: calcDelta(week.usd, weekPrev.usd),
      monthVsPrev: calcDelta(month.usd, monthPrev.usd),
    };

    const health = calcHealth({
      rateLimiterDayPct,
      forecastConfidence: forecast.confidence,
      anomaliesCount: anomalies.length,
      monthVsPrevDirection: trends.monthVsPrev.direction,
      flashPctOfTotal,
    });

    const recommendations = buildRecommendations({
      savings,
      rateLimiterDayPct,
      forecast,
      anomalies,
      monthDelta: trends.monthVsPrev,
      flashPctOfTotal,
      burnRate,
    });

    const { rows: lastRows } = await query<{ last: string }>(
      `SELECT MAX(created_at)::text AS last FROM agent_usage`,
    );

    const result: UsageSummary = {
      totals: {
        today: todayWindow,
        week: { calls: week.calls, usd: week.usd, clp: toClp(week.usd) },
        month: { calls: month.calls, usd: month.usd, clp: toClp(month.usd) },
        all: { calls: all.calls, usd: all.usd, clp: toClp(all.usd) },
      },
      trends, byModel, daily, heatmap, forecast, savings, topSources, anomalies,
      rateLimiter,
      tokens, burnRate, histogram, health, recommendations,
      sameDayLastWeek,
      meta: {
        clpPerUsd: CLP_PER_USD,
        lastCallAt: lastRows[0]?.last ?? null,
        tableExists: true,
        cachedAt: new Date().toISOString(),
        ttlSeconds: CACHE_TTL_MS / 1000,
        version: "0.12.6",
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

function buildEmpty(): UsageSummary {
  return {
    totals: { today: EMPTY_WINDOW, week: EMPTY_WINDOW, month: EMPTY_WINDOW, all: EMPTY_WINDOW },
    trends: { weekVsPrev: FLAT_DELTA, monthVsPrev: FLAT_DELTA },
    byModel: [], daily: [], heatmap: [], topSources: [], anomalies: [],
    forecast: { eomCalls: 0, eomUsd: 0, eomClp: 0, confidence: "low", basedOnDays: 0 },
    savings: { ifAllFlashLite: { monthUsd: 0, monthClp: 0, savedUsd: 0, savedClp: 0, savedPct: 0 } },
    rateLimiter: getGeminiRateLimitStats(),
    tokens: { input: 0, output: 0, total: 0, inputUsd: 0, outputUsd: 0, inputPct: 0, outputPct: 0 },
    burnRate: { lastHourCalls: 0, lastHourUsd: 0, prevHourCalls: 0, deltaPct: 0, estimateNext24hUsd: 0, estimateNext24hClp: 0 },
    histogram: [],
    health: { score: 100, status: "excellent", dimensions: [] },
    recommendations: [{ id: "no-data", priority: "low", category: "ops", title: "Sin datos todavía", description: "El agente aún no registró calls.", actionable: false }],
    sameDayLastWeek: { today: EMPTY_WINDOW, sameDayLastWeek: { ...EMPTY_WINDOW, date: "" }, delta: FLAT_DELTA },
    meta: { clpPerUsd: CLP_PER_USD, lastCallAt: null, tableExists: false, cachedAt: new Date().toISOString(), ttlSeconds: CACHE_TTL_MS / 1000, version: "0.12.6" },
  };
}
