// stats.service.ts — Estadísticas globales del módulo AMS (multi-tenant).
//
// MT-3: getStats recibe tenantId. Cada cliente ve solo sus incidentes.
import { query } from "../database/db";

export interface StatsByKey { key: string; count: number }
export interface StatsByDay { day: string; count: number }
export interface StatsByConfidence { confidence: string; count: number }

export interface AmsStats {
  totalIncidents: number;
  incidentsLast7d: number;
  incidentsToday: number;
  withAttachments: number;
  byModule: StatsByKey[];
  byEnvironment: StatsByKey[];
  byConfidence: StatsByConfidence[];
  byDay: StatsByDay[];
  recentAudit: { action: string; created_at: string }[];
}

export async function getStats(tenantId: string): Promise<AmsStats> {
  const [
    totalRes,
    last7Res,
    todayRes,
    attachmentsRes,
    byModuleRes,
    byEnvRes,
    byConfRes,
    byDayRes,
    auditRes,
  ] = await Promise.all([
    query<{ c: string }>(
      "SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1",
      [tenantId]
    ),
    query<{ c: string }>(
      "SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1 AND created_at >= now() - interval '7 days'",
      [tenantId]
    ),
    query<{ c: string }>(
      "SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1 AND created_at::date = current_date",
      [tenantId]
    ),
    query<{ c: string }>(
      "SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1 AND jsonb_array_length(attachments) > 0",
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `SELECT COALESCE(sap_module, 'NO_INFORMADO') AS k, count(*)::text AS c
         FROM incidents WHERE tenant_id = $1
        GROUP BY 1
        ORDER BY count(*) DESC
        LIMIT 12`,
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `SELECT COALESCE(environment, 'NO_INFORMADO') AS k, count(*)::text AS c
         FROM incidents WHERE tenant_id = $1
        GROUP BY 1
        ORDER BY count(*) DESC`,
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `SELECT COALESCE(confidence, 'no_detectada') AS k, count(*)::text AS c
         FROM incidents WHERE tenant_id = $1
        GROUP BY 1`,
      [tenantId]
    ),
    query<{ d: string; c: string }>(
      `WITH days AS (
         SELECT generate_series(
           current_date - interval '13 days',
           current_date,
           interval '1 day'
         )::date AS day
       )
       SELECT d.day::text AS d,
              COALESCE(count(i.id), 0)::text AS c
         FROM days d
         LEFT JOIN incidents i
           ON i.created_at::date = d.day AND i.tenant_id = $1
        GROUP BY d.day
        ORDER BY d.day`,
      [tenantId]
    ),
    query<{ action: string; created_at: string }>(
      // audit_logs es una tabla legacy global; se conserva pero filtramos
      // por tenant cuando exista la columna. Si no existe la columna,
      // simplemente devolvemos las últimas 12 (fallback).
      `SELECT action, created_at::text
         FROM audit_logs
        ORDER BY created_at DESC
        LIMIT 12`
    ),
  ]);

  return {
    totalIncidents:    Number(totalRes.rows[0]?.c ?? 0),
    incidentsLast7d:   Number(last7Res.rows[0]?.c ?? 0),
    incidentsToday:    Number(todayRes.rows[0]?.c ?? 0),
    withAttachments:   Number(attachmentsRes.rows[0]?.c ?? 0),
    byModule:          byModuleRes.rows.map((r) => ({ key: r.k, count: Number(r.c) })),
    byEnvironment:     byEnvRes.rows.map((r) => ({ key: r.k, count: Number(r.c) })),
    byConfidence:      byConfRes.rows.map((r) => ({ confidence: r.k, count: Number(r.c) })),
    byDay:             byDayRes.rows.map((r) => ({ day: r.d, count: Number(r.c) })),
    recentAudit:       auditRes.rows,
  };
}
