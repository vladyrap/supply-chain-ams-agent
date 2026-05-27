// Notificaciones consolidadas: unifica eventos relevantes de varias tablas
// (support_tickets escalados/resueltos, kb_articles aprobados, meetings done,
// incidents nuevos) en una sola lista ordenada por timestamp.
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
  id: string;                  // único: kind:resource_id
  kind: NotificationKind;
  title: string;               // texto principal mostrado
  subtitle?: string;
  href: string;                // ruta a la que lleva el click
  badge?: string;              // ej. "MM", "alta"
  createdAt: string;           // ISO
}

export interface ListNotificationsParams {
  limit?: number;
  /** Solo eventos posteriores a este timestamp (para polling incremental) */
  since?: string;
}

export async function listNotifications(params: ListNotificationsParams = {}): Promise<Notification[]> {
  const limit = Math.min(params.limit ?? 30, 100);
  const since = params.since ? new Date(params.since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // 5 queries en paralelo
  const [
    tktEscalated, tktResolved, kbApproved, meetingsDone, incidents,
  ] = await Promise.all([
    query<{ id: string; code: string; title: string; system_affected: string | null; priority: string; created_at: string }>(
      `SELECT id, code, title, system_affected, priority, created_at::text
         FROM support_tickets
        WHERE created_at > $1
        ORDER BY created_at DESC LIMIT $2`,
      [since.toISOString(), limit]
    ),
    query<{ id: string; code: string; title: string; system_affected: string | null; resolved_at: string }>(
      `SELECT id, code, title, system_affected, resolved_at::text
         FROM support_tickets
        WHERE resolved_at IS NOT NULL AND resolved_at > $1
        ORDER BY resolved_at DESC LIMIT $2`,
      [since.toISOString(), limit]
    ),
    query<{ id: string; title: string; system: string | null; approved_at: string }>(
      `SELECT id, title, system, approved_at::text
         FROM kb_articles
        WHERE status = 'approved' AND approved_at IS NOT NULL AND approved_at > $1
        ORDER BY approved_at DESC LIMIT $2`,
      [since.toISOString(), limit]
    ),
    query<{ id: string; title: string; processed_at: string }>(
      `SELECT id, title, processed_at::text
         FROM meetings
        WHERE status = 'done' AND processed_at IS NOT NULL AND processed_at > $1
        ORDER BY processed_at DESC LIMIT $2`,
      [since.toISOString(), limit]
    ),
    query<{ id: string; message: string; sap_module: string | null; created_at: string }>(
      `SELECT id, message, sap_module, created_at::text
         FROM incidents
        WHERE created_at > $1
        ORDER BY created_at DESC LIMIT $2`,
      [since.toISOString(), Math.min(limit, 15)]   // limitamos incidents porque son los más frecuentes
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

  // Ordenar por timestamp desc y limitar
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out.slice(0, limit);
}
