// =============================================================
// Agente autónomo: jobs cron que el worker ejecuta periódicamente.
// =============================================================
// FIX G5 (audit MT v1.2.0): TODOS los jobs ahora iteran por tenant.
// Antes: queries cross-tenant + emitEvent sin tenantId → alertas mezcladas
// entre clientes (Slack de ACME recibía warnings de BRAVO).
// Patrón: listActiveTenantIds() → for each tenant → query + emit con tenantId.
// =============================================================
import { query } from "../db";
import { logger } from "../logger";
import { emitEvent } from "../emit";

/** Lista tenant ids activos para iterar en cron jobs. Cae a ['default'] si no hay tabla. */
async function listActiveTenantIds(): Promise<string[]> {
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM tenants WHERE status IN ('active','trial') ORDER BY id`
    );
    if (rows.length === 0) return ["default"];
    return rows.map((r) => r.id);
  } catch {
    return ["default"]; // tabla no existe (legacy single-tenant)
  }
}

// ============================================================
// Job 1: SLA cerca de vencer — POR TENANT
// ============================================================
export async function checkSlaWarnings(): Promise<{ found: number; emitted: number }> {
  let found = 0, emitted = 0;
  const tenants = await listActiveTenantIds();
  for (const tenantId of tenants) {
    try {
      const { rows } = await query<{
        id: string; code: string; title: string; system_affected: string | null;
        priority: string; sla_due_at: string; assigned_to: string | null;
      }>(
        `SELECT id, code, title, system_affected, priority, sla_due_at::text, assigned_to
           FROM support_tickets
          WHERE tenant_id = $1
            AND sla_due_at IS NOT NULL
            AND sla_due_at > now()
            AND sla_due_at < now() + interval '30 minutes'
            AND status IN ('new', 'in_progress', 'waiting_customer')
            AND (last_sla_warning_at IS NULL OR last_sla_warning_at < now() - interval '30 minutes')`,
        [tenantId]
      ).catch(async () => {
        return await query<{
          id: string; code: string; title: string; system_affected: string | null;
          priority: string; sla_due_at: string; assigned_to: string | null;
        }>(
          `SELECT id, code, title, system_affected, priority, sla_due_at::text, assigned_to
             FROM support_tickets
            WHERE tenant_id = $1
              AND sla_due_at IS NOT NULL
              AND sla_due_at > now()
              AND sla_due_at < now() + interval '30 minutes'
              AND status IN ('new', 'in_progress', 'waiting_customer')`,
          [tenantId]
        );
      });

      found += rows.length;
      for (const t of rows) {
        const minutesLeft = Math.round((new Date(t.sla_due_at).getTime() - Date.now()) / 60000);
        await emitEvent(tenantId, "ticket.sla_warning", {
          tenant_id: tenantId,
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
      logger.warn({ err, tenantId }, "autonomous.checkSlaWarnings fail per tenant");
    }
  }
  return { found, emitted };
}

// ============================================================
// Job 2: Anomalías de incidentes por tenant
// ============================================================
export async function detectAnomalies(): Promise<{ anomalies: number }> {
  let anomalies = 0;
  const tenants = await listActiveTenantIds();
  for (const tenantId of tenants) {
    try {
      const { rows } = await query<{ sap_module: string; recent: string; baseline: string }>(
        `WITH recent AS (
           SELECT COALESCE(sap_module,'NO_INFORMADO') AS sap_module, count(*)::float AS cnt
             FROM incidents
            WHERE tenant_id = $1
              AND created_at >= now() - interval '1 hour'
            GROUP BY 1
         ),
         baseline AS (
           SELECT COALESCE(sap_module,'NO_INFORMADO') AS sap_module,
                  (count(*) / 336.0) AS hourly_avg
             FROM incidents
            WHERE tenant_id = $1
              AND created_at >= now() - interval '14 days'
              AND created_at < now() - interval '1 hour'
            GROUP BY 1
         )
         SELECT r.sap_module, r.cnt::text AS recent, COALESCE(b.hourly_avg, 0)::text AS baseline
           FROM recent r LEFT JOIN baseline b ON b.sap_module = r.sap_module`,
        [tenantId]
      );
      for (const r of rows) {
        const recent = Number(r.recent);
        const baseline = Number(r.baseline);
        const threshold = baseline * 2 + 3;
        if (recent > threshold && recent >= 3) {
          await emitEvent(tenantId, "incident.anomaly", {
            tenant_id: tenantId,
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
      logger.warn({ err, tenantId }, "autonomous.detectAnomalies fail per tenant");
    }
  }
  return { anomalies };
}

// ============================================================
// Job 3: Conversaciones inactivas por tenant
// ============================================================
export async function reopenStaleConversations(): Promise<{ stale: number }> {
  let stale = 0;
  const tenants = await listActiveTenantIds();
  for (const tenantId of tenants) {
    try {
      const { rows } = await query<{ id: string; user_name: string | null; channel: string; updated_at: string; sap_module: string | null }>(
        `SELECT id, user_name, channel, updated_at::text, sap_module
           FROM support_conversations
          WHERE tenant_id = $1
            AND status = 'waiting_user'
            AND updated_at < now() - interval '24 hours'
          LIMIT 50`,
        [tenantId]
      );
      stale += rows.length;
      for (const c of rows) {
        await emitEvent(tenantId, "conversation.stale", {
          tenant_id: tenantId,
          conversation_id: c.id,
          user: c.user_name,
          channel: c.channel,
          module: c.sap_module,
          idle_hours: Math.round((Date.now() - new Date(c.updated_at).getTime()) / 3600000),
        });
      }
    } catch (err) {
      logger.warn({ err, tenantId }, "autonomous.reopenStale fail per tenant");
    }
  }
  return { stale };
}

// ============================================================
// Job 4: Reporte diario por tenant
// ============================================================
export async function generateDailyReport(): Promise<{ generated: boolean }> {
  let anyGenerated = false;
  const tenants = await listActiveTenantIds();
  for (const tenantId of tenants) {
    try {
      const [inc, tkt, conv, kb, meet] = await Promise.all([
        query<{ c: string }>(
          `SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1 AND created_at::date = current_date`,
          [tenantId],
        ),
        query<{ c: string; closed: string }>(
          `SELECT count(*) FILTER (WHERE status NOT IN ('resolved','closed'))::text AS c,
                  count(*) FILTER (WHERE resolved_at::date = current_date OR closed_at::date = current_date)::text AS closed
             FROM support_tickets WHERE tenant_id = $1`,
          [tenantId],
        ),
        query<{ c: string; ai: string }>(
          `SELECT count(*)::text AS c,
                  count(*) FILTER (WHERE ai_resolved = true)::text AS ai
             FROM support_conversations WHERE tenant_id = $1 AND created_at::date = current_date`,
          [tenantId],
        ),
        query<{ c: string }>(
          `SELECT count(*)::text AS c FROM kb_articles WHERE tenant_id = $1 AND approved_at::date = current_date`,
          [tenantId],
        ),
        query<{ c: string }>(
          `SELECT count(*)::text AS c FROM meetings WHERE tenant_id = $1 AND processed_at::date = current_date`,
          [tenantId],
        ),
      ]);

      const totalConv = Number(conv.rows[0]?.c ?? 0);
      const aiConv = Number(conv.rows[0]?.ai ?? 0);

      await emitEvent(tenantId, "report.daily", {
        tenant_id: tenantId,
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
      anyGenerated = true;
    } catch (err) {
      logger.warn({ err, tenantId }, "autonomous.dailyReport fail per tenant");
    }
  }
  return { generated: anyGenerated };
}
