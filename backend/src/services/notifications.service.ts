// Notificaciones consolidadas (multi-tenant).
//
// MT-3: listNotifications recibe tenantId obligatorio. Unifica eventos
// del tenant desde varias tablas: tickets escalados/resueltos, kb_articles,
// meetings done, incidents nuevos.
//
// El "read" lo maneja el cliente vía localStorage (lastReadTs). El backend
// solo devuelve los eventos; cliente filtra cuáles son "no leídos".
import { query } from "../database/db";

export type NotificationKind =
  | "ticket_escalated"
  | "ticket_resolved"
  | "kb_approved"
  | "meeting_done"
  | "incident_created";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  subtitle?: string;
  href: string;
  badge?: string;
  createdAt: string;
}

export interface ListNotificationsParams {
  limit?: number;
  /** Solo eventos posteriores a este timestamp (para polling incremental) */
  since?: string;
}

export async function listNotifications(
  tenantId: string,
  params: ListNotificationsParams = {},
): Promise<Notification[]> {
  const limit = Math.min(params.limit ?? 30, 100);
  const since = params.since ? new Date(params.since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  // 5 queries en paralelo, todas scoped al tenant
  const [
    tktEscalated, tktResolved, kbApproved, meetingsDone, incidents,
  ] = await Promise.all([
    query<{ id: string; code: string; title: string; system_affected: string | null; priority: string; created_at: string }>(
      `SELECT id, code, title, system_affected, priority, created_at::text
         FROM support_tickets
        WHERE tenant_id = $3 AND created_at > $1
        ORDER BY created_at DESC LIMIT $2`,
      [sinceIso, limit, tenantId]
    ),
    query<{ id: string; code: string; title: string; system_affected: string | null; resolved_at: string }>(
      `SELECT id, code, title, system_affected, resolved_at::text
         FROM support_tickets
        WHERE tenant_id = $3
          AND resolved_at IS NOT NULL AND resolved_at > $1
        ORDER BY resolved_at DESC LIMIT $2`,
      [sinceIso, limit, tenantId]
    ),
    query<{ id: string; title: string; system: string | null; approved_at: string }>(
      `SELECT id, title, system, approved_at::text
         FROM kb_articles
        WHERE tenant_id = $3
          AND status = 'approved' AND approved_at IS NOT NULL AND approved_at > $1
        ORDER BY approved_at DESC LIMIT $2`,
      [sinceIso, limit, tenantId]
    ),
    query<{ id: string; title: string; processed_at: string }>(
      `SELECT id, title, processed_at::text
         FROM meetings
        WHERE tenant_id = $3
          AND status = 'done' AND processed_at IS NOT NULL AND processed_at > $1
        ORDER BY processed_at DESC LIMIT $2`,
      [sinceIso, limit, tenantId]
    ),
    query<{ id: string; message: string; sap_module: string | null; created_at: string }>(
      `SELECT id, message, sap_module, created_at::text
         FROM incidents
        WHERE tenant_id = $3 AND created_at > $1
        ORDER BY created_at DESC LIMIT $2`,
      [sinceIso, Math.min(limit, 15), tenantId]
    ),
  ]);

  const out: Notification[] = [];

  for (const r of tktEscalated.rows) {
    out.push({
      id: `ticket_escalated:${r.id}`,
      kind: "ticket_escalated",
      title: `Ticket escalado · ${r.code}`,
      subtitle: r.title,
      href: "/support-desk/tickets",
      badge: r.priority,
      createdAt: r.created_at,
    });
  }
  for (const r of tktResolved.rows) {
    out.push({
      id: `ticket_resolved:${r.id}`,
      kind: "ticket_resolved",
      title: `${r.code} resuelto`,
      subtitle: r.title,
      href: "/support-desk/tickets",
      badge: r.system_affected ?? undefined,
      createdAt: r.resolved_at,
    });
  }
  for (const r of kbApproved.rows) {
    out.push({
      id: `kb_approved:${r.id}`,
      kind: "kb_approved",
      title: "KB aprobada",
      subtitle: r.title,
      href: "/support-desk/kb",
      badge: r.system ?? undefined,
      createdAt: r.approved_at,
    });
  }
  for (const r of meetingsDone.rows) {
    out.push({
      id: `meeting_done:${r.id}`,
      kind: "meeting_done",
      title: "Reunión procesada",
      subtitle: r.title,
      href: "/meetings",
      createdAt: r.processed_at,
    });
  }
  for (const r of incidents.rows) {
    out.push({
      id: `incident_created:${r.id}`,
      kind: "incident_created",
      title: "Nuevo incidente",
      subtitle: (r.message || "").slice(0, 80),
      href: "/history",
      badge: r.sap_module ?? undefined,
      createdAt: r.created_at,
    });
  }

  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out.slice(0, limit);
}
