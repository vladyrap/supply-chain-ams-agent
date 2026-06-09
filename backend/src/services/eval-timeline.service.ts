// Curva temporal de la evolución del aprendizaje del agente.
//
// Lee qa_eval_runs y agrupa por día → devuelve puntos {date, avgScore,
// passRate, runs, totalQas} para que la UI dibuje una línea temporal.
//
// Drift detection:
//   - Compara pass_rate promedio últimos 7d vs los 7d anteriores.
//   - Si cae > 10 puntos → flag "drift_detected = true" con detalles.

import { query } from "../database/db";
import { logger } from "../utils/logger";

export interface TimelinePoint {
  date: string;           // YYYY-MM-DD
  runs: number;
  totalQas: number;
  avgScore: number;
  passRate: number;       // 0-100
}

export interface DriftReport {
  driftDetected: boolean;
  current7dPassRate: number | null;
  previous7dPassRate: number | null;
  deltaPoints: number | null;
  thresholdPoints: number;
  current7dAvgScore: number | null;
  previous7dAvgScore: number | null;
  scoreDeltaPoints: number | null;
  message: string;
}

export interface TimelineResponse {
  days: number;
  points: TimelinePoint[];
  drift: DriftReport;
}

export async function getEvalTimeline(tenantId: string, daysBack = 30, driftThreshold = 10): Promise<TimelineResponse> {
  const safeDays = Math.max(7, Math.min(180, daysBack));
  let points: TimelinePoint[] = [];
  try {
    const { rows } = await query<{
      day: string; runs: string; total_qas: string; avg_score: string; pass_rate: string;
    }>(
      `SELECT date_trunc('day', started_at)::date::text AS day,
              count(*)::text AS runs,
              COALESCE(sum(total_qas), 0)::text AS total_qas,
              COALESCE(round(avg(avg_score)), 0)::text AS avg_score,
              COALESCE(round(avg(CASE WHEN total_qas > 0 THEN passed * 100.0 / total_qas ELSE 0 END), 0)::int, 0)::text AS pass_rate
         FROM qa_eval_runs
        WHERE started_at > now() - ($1 || ' days')::interval
          AND tenant_id = $2
        GROUP BY date_trunc('day', started_at)
        ORDER BY day ASC`,
      [String(safeDays), tenantId]
    );
    points = rows.map((r) => ({
      date: r.day,
      runs: Number(r.runs),
      totalQas: Number(r.total_qas),
      avgScore: Number(r.avg_score),
      passRate: Number(r.pass_rate),
    }));
  } catch (err) {
    logger.debug({ err }, "eval timeline fetch fail");
  }

  // Drift: 7d vs 7d previos
  let current7dPassRate: number | null = null;
  let previous7dPassRate: number | null = null;
  let current7dAvgScore: number | null = null;
  let previous7dAvgScore: number | null = null;
  try {
    const { rows } = await query<{ window: string; avg_score: string | null; pass_rate: string | null }>(
      `SELECT
         CASE
           WHEN started_at > now() - interval '7 days' THEN 'current'
           WHEN started_at > now() - interval '14 days' THEN 'previous'
           ELSE 'older'
         END AS window,
         round(avg(avg_score))::text AS avg_score,
         round(avg(CASE WHEN total_qas > 0 THEN passed * 100.0 / total_qas ELSE 0 END))::text AS pass_rate
       FROM qa_eval_runs
       WHERE started_at > now() - interval '14 days'
         AND total_qas > 0
         AND tenant_id = $1
       GROUP BY 1`,
      [tenantId]
    );
    for (const r of rows) {
      if (r.window === "current") {
        current7dPassRate = r.pass_rate !== null ? Number(r.pass_rate) : null;
        current7dAvgScore = r.avg_score !== null ? Number(r.avg_score) : null;
      } else if (r.window === "previous") {
        previous7dPassRate = r.pass_rate !== null ? Number(r.pass_rate) : null;
        previous7dAvgScore = r.avg_score !== null ? Number(r.avg_score) : null;
      }
    }
  } catch (err) {
    logger.debug({ err }, "drift fetch fail");
  }

  const deltaPoints =
    current7dPassRate !== null && previous7dPassRate !== null
      ? current7dPassRate - previous7dPassRate
      : null;
  const scoreDeltaPoints =
    current7dAvgScore !== null && previous7dAvgScore !== null
      ? current7dAvgScore - previous7dAvgScore
      : null;
  const driftDetected = deltaPoints !== null && deltaPoints <= -driftThreshold;

  const message = driftDetected
    ? `🚨 DRIFT: pass rate cayó ${Math.abs(deltaPoints!)} puntos vs semana previa (${previous7dPassRate}% → ${current7dPassRate}%).`
    : deltaPoints !== null
      ? `Variación pass rate últimos 7d: ${deltaPoints > 0 ? "+" : ""}${deltaPoints} pts`
      : "Aún no hay suficientes evaluaciones para detectar drift.";

  return {
    days: safeDays,
    points,
    drift: {
      driftDetected,
      current7dPassRate,
      previous7dPassRate,
      deltaPoints,
      thresholdPoints: driftThreshold,
      current7dAvgScore,
      previous7dAvgScore,
      scoreDeltaPoints,
      message,
    },
  };
}
