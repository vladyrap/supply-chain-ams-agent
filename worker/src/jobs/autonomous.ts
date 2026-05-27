// =============================================================
// Agente autónomo: jobs cron que el worker ejecuta periódicamente.
// =============================================================
// Cada job es defensivo: si algo falla, loggea y sigue. NUNCA tira
// el worker. NUNCA modifica datos productivos — solo lee, decide,
// emite eventos hacia las integraciones para que actúen.
// =============================================================
import { query } from "../db";
import { logger } from "../logger";
import { emitEvent } from "../emit";

// ============================================================
// Job 1: SLA cerca de vencer
// ============================================================
// Cada 5 minutos: tickets con sla_due_at en los próximos 30 min y
// status activo → emite evento ticket.sla_warning.
// ============================================================
export async function checkSlaWarnings(): Promise<{ found: number; emitted: number }> {
  let found = 0, emitted = 0;
  try {
    const { rows } = await query<{
      id: string; code: string; title: string; system_affected: string | null;
      priority: string; sla_due_at: string; assigned_to: string | null;
    }>(
      `SELECT id, code, title, system_affected, priority, sla_due_at::text, assigned_to
         FROM support_tickets
        WHERE sla_due_at IS NOT NULL
          AND sla_due_at > now()
          AND sla_due_at < now() + interval '30 minutes'
          AND status IN ('new', 'in_progress', 'waiting_customer')
          AND (last_sla_warning_at IS NULL OR last_sla_warning_at < now() - interval '30 minutes')`
    ).catch(async () => {
      // Si la columna last_sla_warning_at no existe, fallback sin ella
      return await query<{
        id: string; code: string; title: string; system_affected: string | null;
        priority: string; sla_due_at: string; assigned_to: string | null;
      }>(
        `SELECT id, code, title, system_affected, priority, sla_due_at::text, assigned_to
           FROM support_tickets
          WHERE sla_due_at IS NOT NULL
            AND sla_due_at > now()
            AND sla_due_at < now() + interval '30 minutes'
            AND status IN ('new', 'in_progress', 'waiting_customer')`
      );
    });

    found = rows.length;
    for (const t of rows) {
      const minutesLeft = Math.round((new Date(t.sla_due_at).getTime() - Date.now()) / 60000);
      await emitEvent("ticket.sla_warning", {
        code: t.code,
        title: t.title,
        priority: t.priority,
        system_affected: t.system_affected,
        sla_due_at: t.sla_due_at,
        minutes_left: minutesLeft,
        assigned_to: t.assigned_to,
      });
      emitted++;
    }
  } catch (err) {
    logger.warn({ err }, "autonomous.checkSlaWarnings fail");
  }
  return { found, emitted };
}

// ============================================================
// Job 2: Detección de anomalías sobre incidentes por módulo/hora
// ============================================================
// Cada hora: compara conteo de incidentes en la última hora vs la media
// del mismo módulo en los últimos 14 días. Si pico > 2× media + 3,
// emite evento incident.anomaly.
// ============================================================
export async function detectAnomalies(): Promise<{ anomalies: number }> {
  let anomalies = 0;
  try {
    const { rows } = await query<{ sap_module: string; recent: string; baseline: string }>(
      `WITH recent AS (
         SELECT COALESCE(sap_module,'NO_INFORMADO') AS sap_module, count(*)::float AS cnt
           FROM incidents
          WHERE created_at >= now() - interval '1 hour'
          GROUP BY 1
       ),
       baseline AS (
         SELECT COALESCE(sap_module,'NO_INFORMADO') AS sap_module,
                (count(*) / 336.0) AS hourly_avg   -- 14 días × 24 hs
           FROM incidents
          WHERE created_at >= now() - interval '14 days'
            AND created_at < now() - interval '1 hour'
          GROUP BY 1
       )
       SELECT r.sap_module, r.cnt::text AS recent, COALESCE(b.hourly_avg, 0)::text AS baseline
         FROM recent r LEFT JOIN baseline b ON b.sap_module = r.sap_module`
    );
    for (const r of rows) {
      const recent = Number(r.recent);
      const baseline = Number(r.baseline);
      // Umbral: pico > 2x media histórica + 3 incidentes mínimos
      const threshold = baseline * 2 + 3;
      if (recent > threshold && recent >= 3) {
        await emitEvent("incident.anomaly", {
          module: r.sap_module,
          recent_count: recent,
          baseline_hourly_avg: Number(baseline.toFixed(2)),
          threshold: Number(threshold.toFixed(2)),
          period: "last_hour",
        });
        anomalies++;
      }
    }
  } catch (err) {
    logger.warn({ err }, "autonomous.detectAnomalies fail");
  }
  return { anomalies };
}

// ============================================================
// Job 3: Reabrir conversaciones inactivas
// ============================================================
// Cada hora: conversaciones con status='waiting_user' por más de 24h
// → emite evento conversation.stale + opcionalmente cambia status para
//   que la mesa las cierre manualmente.
// ============================================================
export async function reopenStaleConversations(): Promise<{ stale: number }> {
  let stale = 0;
  try {
    const { rows } = await query<{ id: string; user_name: string | null; channel: string; updated_at: string; sap_module: string | null }>(
      `SELECT id, user_name, channel, updated_at::text, sap_module
         FROM support_conversations
        WHERE status = 'waiting_user'
          AND updated_at < now() - interval '24 hours'
        LIMIT 50`
    );
    stale = rows.length;
    for (const c of rows) {
      await emitEvent("conversation.stale", {
        conversation_id: c.id,
        user: c.user_name,
        channel: c.channel,
        module: c.sap_module,
        idle_hours: Math.round((Date.now() - new Date(c.updated_at).getTime()) / 3600000),
      });
    }
  } catch (err) {
    logger.warn({ err }, "autonomous.reopenStale fail");
  }
  return { stale };
}

// ============================================================
// Job 4: Reporte diario ejecutivo
// ============================================================
// Cada día (cron) genera un resumen y emite report.daily.
// Las integraciones tipo email/slack lo despachan a los destinatarios.
// ============================================================
export async function generateDailyReport(): Promise<{ generated: boolean }> {
  try {
    const [inc, tkt, conv, kb, meet] = await Promise.all([
      query<{ c: string }>(`SELECT count(*)::text AS c FROM incidents WHERE created_at::date = current_date`),
      query<{ c: string; closed: string }>(
        `SELECT count(*) FILTER (WHERE status NOT IN ('resolved','closed'))::text AS c,
                count(*) FILTER (WHERE resolved_at::date = current_date OR closed_at::date = current_date)::text AS closed
           FROM support_tickets`
      ),
      query<{ c: string; ai: string }>(
        `SELECT count(*)::text AS c,
                count(*) FILTER (WHERE ai_resolved = true)::text AS ai
           FROM support_conversations WHERE created_at::date = current_date`
      ),
      query<{ c: string }>(`SELECT count(*)::text AS c FROM kb_articles WHERE approved_at::date = current_date`),
      query<{ c: string }>(`SELECT count(*)::text AS c FROM meetings WHERE processed_at::date = current_date`),
    ]);

    const totalConv = Number(conv.rows[0]?.c ?? 0);
    const aiConv = Number(conv.rows[0]?.ai ?? 0);

    await emitEvent("report.daily", {
      date: new Date().toISOString().slice(0, 10),
      incidents_today: Number(inc.rows[0]?.c ?? 0),
      tickets_active: Number(tkt.rows[0]?.c ?? 0),
      tickets_closed_today: Number(tkt.rows[0]?.closed ?? 0),
      conversations_today: totalConv,
      conversations_resolved_by_ai: aiConv,
      ai_resolution_rate: totalConv > 0 ? Math.round((aiConv / totalConv) * 100) : 0,
      kb_articles_approved_today: Number(kb.rows[0]?.c ?? 0),
      meetings_processed_today: Number(meet.rows[0]?.c ?? 0),
    });
    return { generated: true };
  } catch (err) {
    logger.warn({ err }, "autonomous.dailyReport fail");
    return { generated: false };
  }
}
