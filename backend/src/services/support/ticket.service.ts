import { query } from "../../database/db";
import { logger } from "../../utils/logger";
import type {
  SupportTicket, TicketStatus, Priority,
} from "../../types/support.types";

export interface CreateTicketInput {
  conversationId?: string | null;
  title: string;
  summary: string;
  systemAffected?: string;
  category?: string;
  priority: Priority;
  slaMinutes: number;
  assignedRole?: string;
  evidences?: { type: string; label: string; value: string }[];
}

async function nextCode(): Promise<string> {
  const { rows } = await query<{ n: string }>(`SELECT nextval('support_ticket_seq')::text AS n`);
  const n = Number(rows[0]?.n ?? 1);
  return `MESA-${String(n).padStart(4, "0")}`;
}

export async function createTicket(input: CreateTicketInput): Promise<SupportTicket> {
  const code = await nextCode();
  const slaDueAt = new Date(Date.now() + input.slaMinutes * 60 * 1000).toISOString();
  const { rows } = await query<SupportTicket>(
    `INSERT INTO support_tickets
       (code, conversation_id, title, summary, system_affected, category,
        priority, sla_minutes, sla_due_at, assigned_role, evidences,
        status, created_by_ai)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'new', true)
     RETURNING *`,
    [
      code,
      input.conversationId ?? null,
      input.title,
      input.summary,
      input.systemAffected ?? null,
      input.category ?? null,
      input.priority,
      input.slaMinutes,
      slaDueAt,
      input.assignedRole ?? null,
      JSON.stringify(input.evidences ?? []),
    ]
  );
  return rows[0]!;
}

export async function listTickets(filters: {
  status?: TicketStatus;
  priority?: Priority;
  assignedTo?: string;
  systemAffected?: string;
  limit?: number;
} = {}): Promise<SupportTicket[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.status)         { params.push(filters.status);         conds.push(`status = $${params.length}`); }
  if (filters.priority)       { params.push(filters.priority);       conds.push(`priority = $${params.length}`); }
  if (filters.assignedTo)     { params.push(filters.assignedTo);     conds.push(`assigned_to = $${params.length}`); }
  if (filters.systemAffected) { params.push(filters.systemAffected); conds.push(`system_affected = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 200, 500);
  params.push(limit);
  const { rows } = await query<SupportTicket>(
    `SELECT * FROM support_tickets ${where}
       ORDER BY
         CASE priority
           WHEN 'critica' THEN 1
           WHEN 'alta'    THEN 2
           WHEN 'media'   THEN 3
           ELSE 4
         END,
         created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return rows;
}

export async function getTicketById(id: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(`SELECT * FROM support_tickets WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getTicketByCode(code: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(`SELECT * FROM support_tickets WHERE code = $1`, [code]);
  return rows[0] ?? null;
}

export async function assignTicket(id: string, userId: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(
    `UPDATE support_tickets
        SET assigned_to = $1, status = CASE WHEN status='new' THEN 'in_progress' ELSE status END,
            updated_at = now()
      WHERE id = $2
      RETURNING *`,
    [userId, id]
  );
  return rows[0] ?? null;
}

export async function resolveTicket(id: string, resolution: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(
    `UPDATE support_tickets
        SET status = 'resolved',
            resolution = $1,
            resolved_at = now(),
            updated_at = now()
      WHERE id = $2
      RETURNING *`,
    [resolution, id]
  );
  return rows[0] ?? null;
}

export async function closeTicket(id: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(
    `UPDATE support_tickets
        SET status = 'closed', closed_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

export async function setTicketStatus(id: string, status: TicketStatus): Promise<SupportTicket | null> {
  // Auto-sincroniza timestamps según el estado nuevo (drag&drop Kanban).
  const setResolved = status === "resolved" ? "resolved_at = COALESCE(resolved_at, now())" : "resolved_at = resolved_at";
  const setClosed   = status === "closed"   ? "closed_at   = COALESCE(closed_at, now())"   : "closed_at   = closed_at";
  const { rows } = await query<SupportTicket>(
    `UPDATE support_tickets
        SET status = $1,
            ${setResolved},
            ${setClosed},
            updated_at = now()
      WHERE id = $2
      RETURNING *`,
    [status, id]
  );
  return rows[0] ?? null;
}

export async function linkKbArticle(ticketId: string, kbArticleId: string): Promise<void> {
  try {
    await query(
      `UPDATE support_tickets SET kb_article_id = $1, updated_at = now() WHERE id = $2`,
      [kbArticleId, ticketId]
    );
  } catch (err) {
    logger.warn({ err, ticketId, kbArticleId }, "ticket.linkKbArticle fail");
  }
}
