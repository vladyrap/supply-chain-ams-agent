// Dashboard avanzado + ejecutivo (multi-tenant).
//
// MT-3: getDashboardAdvanced y getDashboardExecutive reciben tenantId
// obligatorio. Cada cliente ve solo sus KPIs.
import { query } from "../database/db";

const EST_USD_PER_INCIDENT = Number(process.env.EST_USD_PER_INCIDENT ?? 0.001);

export interface DashboardAdvanced {
  totals: {
    incidents: number;
    incidentsToday: number;
    incidentsLast7d: number;
    incidentsWithAttachments: number;
    supportConversations: number;
    supportConversationsOpen: number;
    aiResolvedRate: number;
    supportTicketsActive: number;
    supportTicketsSlaBreaches: number;
    meetingsDone: number;
    kbApproved: number;
  };
  heatmap: { day: number; hour: number; value: number }[];
  byModule: { key: string; count: number }[];
  byConfidence: { key: string; count: number }[];
  byUrgency: { key: string; count: number }[];
  sla: { inSla: number; breaching: number; okPct: number };
  topUsers: { name: string; count: number }[];
  topSystems: { key: string; count: number }[];
  timeline: { day: string; incidents: number; tickets: number; meetings: number }[];
}

export async function getDashboardAdvanced(tenantId: string): Promise<DashboardAdvanced> {
  const [
    incTotal, incToday, inc7d, incAttach,
    convTotal, convOpen, aiResRow, tktActive, slaBreach,
    meetDone, kbApprovedRow,
    heatmapRows, byModuleRows, byConfRows, byUrgRows,
    slaInRow, slaOutRow, topUsersRows, topSystemsRows, timelineRows,
  ] = await Promise.all([
    query<{ c: string }>("SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1", [tenantId]),
    query<{ c: string }>("SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1 AND created_at::date = current_date", [tenantId]),
    query<{ c: string }>("SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1 AND created_at >= now() - interval '7 days'", [tenantId]),
    query<{ c: string }>("SELECT count(*)::text AS c FROM incidents WHERE tenant_id = $1 AND jsonb_array_length(attachments) > 0", [tenantId]),

    query<{ c: string }>("SELECT count(*)::text AS c FROM support_conversations WHERE tenant_id = $1", [tenantId]),
    query<{ c: string }>("SELECT count(*)::text AS c FROM support_conversations WHERE tenant_id = $1 AND status IN ('open','ai_handling','waiting_user')", [tenantId]),
    query<{ closed: string; resolved: string }>(
      `SELECT count(*) FILTER (WHERE status IN ('resolved','closed'))::text AS closed,
              count(*) FILTER (WHERE ai_resolved = true)::text AS resolved
         FROM support_conversations WHERE tenant_id = $1`,
      [tenantId]
    ),
    query<{ c: string }>("SELECT count(*)::text AS c FROM support_tickets WHERE tenant_id = $1 AND status IN ('new','in_progress','waiting_customer')", [tenantId]),
    query<{ c: string }>("SELECT count(*)::text AS c FROM support_tickets WHERE tenant_id = $1 AND sla_due_at IS NOT NULL AND sla_due_at < now() AND status NOT IN ('resolved','closed')", [tenantId]),
    query<{ c: string }>("SELECT count(*)::text AS c FROM meetings WHERE tenant_id = $1 AND status='done'", [tenantId]),
    query<{ c: string }>("SELECT count(*)::text AS c FROM kb_articles WHERE tenant_id = $1 AND status='approved'", [tenantId]),

    query<{ dow: string; hr: string; cnt: string }>(
      `WITH combined AS (
         SELECT created_at FROM incidents WHERE tenant_id = $1 AND created_at >= now() - interval '14 days'
         UNION ALL
         SELECT created_at FROM support_tickets WHERE tenant_id = $1 AND created_at >= now() - interval '14 days'
         UNION ALL
         SELECT created_at FROM meetings WHERE tenant_id = $1 AND created_at >= now() - interval '14 days'
       )
       SELECT
         ((EXTRACT(DOW FROM created_at)::int + 6) % 7)::text AS dow,
         EXTRACT(HOUR FROM created_at)::text AS hr,
         count(*)::text AS cnt
       FROM combined
       GROUP BY dow, hr`,
      [tenantId]
    ),

    query<{ k: string; c: string }>(
      `SELECT COALESCE(sap_module, 'NO_INFORMADO') AS k, count(*)::text AS c
         FROM incidents WHERE tenant_id = $1 GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`,
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `SELECT COALESCE(confidence, 'no_detectada') AS k, count(*)::text AS c
         FROM incidents WHERE tenant_id = $1 GROUP BY 1`,
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `SELECT COALESCE(urgency, 'media') AS k, count(*)::text AS c
         FROM support_conversations WHERE tenant_id = $1 AND urgency IS NOT NULL GROUP BY 1`,
      [tenantId]
    ),

    query<{ c: string }>(
      `SELECT count(*)::text AS c FROM support_tickets
        WHERE tenant_id = $1 AND sla_due_at IS NOT NULL AND sla_due_at >= now() AND status NOT IN ('resolved','closed')`,
      [tenantId]
    ),
    query<{ c: string }>(
      `SELECT count(*)::text AS c FROM support_tickets
        WHERE tenant_id = $1 AND sla_due_at IS NOT NULL AND sla_due_at < now() AND status NOT IN ('resolved','closed')`,
      [tenantId]
    ),

    query<{ name: string; c: string }>(
      `SELECT COALESCE(user_name, 'anonymous') AS name, count(*)::text AS c
         FROM incidents
        WHERE tenant_id = $1 AND user_name IS NOT NULL
        GROUP BY user_name ORDER BY count(*) DESC LIMIT 5`,
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `SELECT COALESCE(system_affected, 'NO_INFORMADO') AS k, count(*)::text AS c
         FROM support_tickets
        WHERE tenant_id = $1
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 5`,
      [tenantId]
    ),

    query<{ d: string; incidents: string; tickets: string; meetings: string }>(
      `WITH days AS (
         SELECT generate_series(
           current_date - interval '13 days', current_date, interval '1 day'
         )::date AS day
       )
       SELECT d.day::text AS d,
              COALESCE((SELECT count(*) FROM incidents       WHERE tenant_id = $1 AND created_at::date = d.day), 0)::text AS incidents,
              COALESCE((SELECT count(*) FROM support_tickets WHERE tenant_id = $1 AND created_at::date = d.day), 0)::text AS tickets,
              COALESCE((SELECT count(*) FROM meetings        WHERE tenant_id = $1 AND created_at::date = d.day), 0)::text AS meetings
         FROM days d ORDER BY d.day`,
      [tenantId]
    ),
  ]);

  const aiClosed   = Number(aiResRow.rows[0]?.closed ?? 0);
  const aiResolved = Number(aiResRow.rows[0]?.resolved ?? 0);
  const aiRate     = aiClosed > 0 ? Math.round((aiResolved / aiClosed) * 100) : 0;

  const slaIn  = Number(slaInRow.rows[0]?.c ?? 0);
  const slaOut = Number(slaOutRow.rows[0]?.c ?? 0);
  const slaTotal = slaIn + slaOut;
  const slaOkPct = slaTotal > 0 ? Math.round((slaIn / slaTotal) * 100) : 100;

  return {
    totals: {
      incidents:                Number(incTotal.rows[0]?.c ?? 0),
      incidentsToday:           Number(incToday.rows[0]?.c ?? 0),
      incidentsLast7d:          Number(inc7d.rows[0]?.c ?? 0),
      incidentsWithAttachments: Number(incAttach.rows[0]?.c ?? 0),
      supportConversations:     Number(convTotal.rows[0]?.c ?? 0),
      supportConversationsOpen: Number(convOpen.rows[0]?.c ?? 0),
      aiResolvedRate:           aiRate,
      supportTicketsActive:     Number(tktActive.rows[0]?.c ?? 0),
      supportTicketsSlaBreaches: Number(slaBreach.rows[0]?.c ?? 0),
      meetingsDone:             Number(meetDone.rows[0]?.c ?? 0),
      kbApproved:               Number(kbApprovedRow.rows[0]?.c ?? 0),
    },
    heatmap: heatmapRows.rows.map((r) => ({
      day: Number(r.dow), hour: Number(r.hr), value: Number(r.cnt),
    })),
    byModule:    byModuleRows.rows.map((r) => ({ key: r.k, count: Number(r.c) })),
    byConfidence: byConfRows.rows.map((r) => ({ key: r.k, count: Number(r.c) })),
    byUrgency:   byUrgRows.rows.map((r) => ({ key: r.k, count: Number(r.c) })),
    sla: { inSla: slaIn, breaching: slaOut, okPct: slaOkPct },
    topUsers: topUsersRows.rows.map((r) => ({ name: r.name, count: Number(r.c) })),
    topSystems: topSystemsRows.rows.map((r) => ({ key: r.k, count: Number(r.c) })),
    timeline: timelineRows.rows.map((r) => ({
      day: r.d,
      incidents: Number(r.incidents),
      tickets: Number(r.tickets),
      meetings: Number(r.meetings),
    })),
  };
}

// ============================================================
// Dashboard ejecutivo: KPIs comerciales para C-level / cliente (scoped)
// ============================================================
export interface DashboardExecutive {
  period: { from: string; to: string; days: number };
  kpis: {
    totalInteractions: number;
    incidentsMonth: number;
    ticketsResolvedMonth: number;
    aiResolutionRate: number;
    slaCompliancePct: number;
    avgResponseTimeMin: number;
    kbArticlesCreated: number;
    estimatedCostUsd: number;
    costPerInteractionUsd: number;
  };
  byClient: { name: string; incidents: number; tickets: number; total: number }[];
  byModule: { key: string; count: number }[];
  trend: { day: string; interactions: number }[];
  topAgents: { name: string; resolved: number }[];
}

export async function getDashboardExecutive(tenantId: string, days = 30): Promise<DashboardExecutive> {
  const safeDays = Math.max(1, Math.min(days, 365));
  const interval = `${safeDays} days`;

  const [
    incMonth, ticketsResolvedMonth, convStats, slaStats, avgResp,
    kbCreated, byClientIncRows, byClientConvRows, byModuleRows, trendRows, topAgentsRows,
  ] = await Promise.all([
    query<{ c: string }>(
      `SELECT count(*)::text AS c FROM incidents
        WHERE tenant_id = $1 AND created_at >= now() - interval '${interval}'`,
      [tenantId]
    ),
    query<{ c: string }>(
      `SELECT count(*)::text AS c FROM support_tickets
        WHERE tenant_id = $1
          AND status IN ('resolved','closed')
          AND resolved_at >= now() - interval '${interval}'`,
      [tenantId]
    ),
    query<{ closed: string; ai: string }>(
      `SELECT count(*) FILTER (WHERE status IN ('resolved','closed'))::text AS closed,
              count(*) FILTER (WHERE ai_resolved = true)::text AS ai
         FROM support_conversations
        WHERE tenant_id = $1 AND created_at >= now() - interval '${interval}'`,
      [tenantId]
    ),
    query<{ ok: string; bad: string }>(
      `SELECT count(*) FILTER (WHERE resolved_at IS NOT NULL AND sla_due_at IS NOT NULL AND resolved_at <= sla_due_at)::text AS ok,
              count(*) FILTER (WHERE resolved_at IS NOT NULL AND sla_due_at IS NOT NULL AND resolved_at >  sla_due_at)::text AS bad
         FROM support_tickets
        WHERE tenant_id = $1 AND resolved_at >= now() - interval '${interval}'`,
      [tenantId]
    ),
    query<{ avg_min: string | null }>(
      `SELECT (EXTRACT(EPOCH FROM AVG(resolved_at - created_at)) / 60)::text AS avg_min
         FROM support_tickets
        WHERE tenant_id = $1
          AND resolved_at IS NOT NULL
          AND resolved_at >= now() - interval '${interval}'`,
      [tenantId]
    ),
    query<{ c: string }>(
      `SELECT count(*)::text AS c FROM kb_articles
        WHERE tenant_id = $1
          AND status='approved'
          AND created_at >= now() - interval '${interval}'`,
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `SELECT COALESCE(NULLIF(client_name,''), 'NO_INFORMADO') AS k, count(*)::text AS c
         FROM incidents
        WHERE tenant_id = $1
          AND created_at >= now() - interval '${interval}'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 10`,
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `SELECT COALESCE(NULLIF(client,''), 'NO_INFORMADO') AS k, count(*)::text AS c
         FROM support_conversations
        WHERE tenant_id = $1
          AND created_at >= now() - interval '${interval}'
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 10`,
      [tenantId]
    ),
    query<{ k: string; c: string }>(
      `WITH combined AS (
         SELECT sap_module FROM incidents             WHERE tenant_id = $1 AND created_at >= now() - interval '${interval}'
         UNION ALL
         SELECT sap_module FROM support_conversations WHERE tenant_id = $1 AND created_at >= now() - interval '${interval}'
       )
       SELECT COALESCE(NULLIF(sap_module,''), 'NO_INFORMADO') AS k, count(*)::text AS c
         FROM combined GROUP BY 1 ORDER BY count(*) DESC LIMIT 8`,
      [tenantId]
    ),
    query<{ d: string; n: string }>(
      `WITH days AS (
         SELECT generate_series(
           current_date - interval '${safeDays - 1} days', current_date, interval '1 day'
         )::date AS day
       )
       SELECT d.day::text AS d,
              (
                COALESCE((SELECT count(*) FROM incidents             WHERE tenant_id = $1 AND created_at::date = d.day), 0) +
                COALESCE((SELECT count(*) FROM support_conversations WHERE tenant_id = $1 AND created_at::date = d.day), 0)
              )::text AS n
         FROM days d ORDER BY d.day`,
      [tenantId]
    ),
    query<{ name: string; c: string }>(
      `SELECT COALESCE(u.name, 'sin asignar') AS name, count(*)::text AS c
         FROM support_tickets t
         LEFT JOIN users u ON u.id = t.assigned_to
        WHERE t.tenant_id = $1
          AND t.resolved_at IS NOT NULL AND t.resolved_at >= now() - interval '${interval}'
          AND t.assigned_to IS NOT NULL
        GROUP BY u.name ORDER BY count(*) DESC LIMIT 5`,
      [tenantId]
    ),
  ]);

  const incMo = Number(incMonth.rows[0]?.c ?? 0);
  const tktRes = Number(ticketsResolvedMonth.rows[0]?.c ?? 0);
  const convClosed = Number(convStats.rows[0]?.closed ?? 0);
  const convAi = Number(convStats.rows[0]?.ai ?? 0);
  const aiRate = convClosed > 0 ? Math.round((convAi / convClosed) * 100) : 0;
  const slaOk = Number(slaStats.rows[0]?.ok ?? 0);
  const slaBad = Number(slaStats.rows[0]?.bad ?? 0);
  const slaTotal = slaOk + slaBad;
  const slaPct = slaTotal > 0 ? Math.round((slaOk / slaTotal) * 100) : 100;
  const avgMin = avgResp.rows[0]?.avg_min ? Math.round(Number(avgResp.rows[0].avg_min)) : 0;

  const clientMap = new Map<string, { incidents: number; tickets: number }>();
  for (const r of byClientIncRows.rows) clientMap.set(r.k, { incidents: Number(r.c), tickets: 0 });
  for (const r of byClientConvRows.rows) {
    const cur = clientMap.get(r.k) ?? { incidents: 0, tickets: 0 };
    cur.tickets = Number(r.c);
    clientMap.set(r.k, cur);
  }
  const byClient = Array.from(clientMap.entries())
    .map(([name, v]) => ({ name, incidents: v.incidents, tickets: v.tickets, total: v.incidents + v.tickets }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const totalInteractions = incMo + convClosed + Number(convStats.rows[0]?.ai ?? 0); // approx
  const estCost = Math.round(incMo * EST_USD_PER_INCIDENT * 100) / 100;

  const now = new Date();
  const from = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000);

  return {
    period: { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), days: safeDays },
    kpis: {
      totalInteractions,
      incidentsMonth: incMo,
      ticketsResolvedMonth: tktRes,
      aiResolutionRate: aiRate,
      slaCompliancePct: slaPct,
      avgResponseTimeMin: avgMin,
      kbArticlesCreated: Number(kbCreated.rows[0]?.c ?? 0),
      estimatedCostUsd: estCost,
      costPerInteractionUsd: EST_USD_PER_INCIDENT,
    },
    byClient,
    byModule: byModuleRows.rows.map((r) => ({ key: r.k, count: Number(r.c) })),
    trend: trendRows.rows.map((r) => ({ day: r.d, interactions: Number(r.n) })),
    topAgents: topAgentsRows.rows.map((r) => ({ name: r.name, resolved: Number(r.c) })),
  };
}
