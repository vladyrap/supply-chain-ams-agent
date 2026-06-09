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

export async function createTicket(tenantId: string, input: CreateTicketInput): Promise<SupportTicket> {
  const code = await nextCode();
  const slaDueAt = new Date(Date.now() + input.slaMinutes * 60 * 1000).toISOString();
  const { rows } = await query<SupportTicket>(
    `INSERT INTO support_tickets
       (tenant_id, code, conversation_id, title, summary, system_affected, category,
        priority, sla_minutes, sla_due_at, assigned_role, evidences,
        status, created_by_ai)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, 'new', true)
     RETURNING *`,
    [
      tenantId,
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

export async function listTickets(tenantId: string, filters: {
  status?: TicketStatus;
  priority?: Priority;
  assignedTo?: string;
  systemAffected?: string;
  limit?: number;
} = {}): Promise<SupportTicket[]> {
  const conds: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  if (filters.status)         { params.push(filters.status);         conds.push(`status = $${params.length}`); }
  if (filters.priority)       { params.push(filters.priority);       conds.push(`priority = $${params.length}`); }
  if (filters.assignedTo)     { params.push(filters.assignedTo);     conds.push(`assigned_to = $${params.length}`); }
  if (filters.systemAffected) { params.push(filters.systemAffected); conds.push(`system_affected = $${params.length}`); }
  const where = `WHERE ${conds.join(" AND ")}`;
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

export async function getTicketById(tenantId: string, id: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(
    `SELECT * FROM support_tickets WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function getTicketByCode(tenantId: string, code: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(
    `SELECT * FROM support_tickets WHERE code = $1 AND tenant_id = $2`,
    [code, tenantId]
  );
  return rows[0] ?? null;
}

export async function assignTicket(tenantId: string, id: string, userId: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(
    `UPDATE support_tickets
        SET assigned_to = $1, status = CASE WHEN status='new' THEN 'in_progress' ELSE status END,
            updated_at = now()
      WHERE id = $2 AND tenant_id = $3
      RETURNING *`,
    [userId, id, tenantId]
  );
  return rows[0] ?? null;
}

export async function resolveTicket(tenantId: string, id: string, resolution: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(
    `UPDATE support_tickets
        SET status = 'resolved',
            resolution = $1,
            resolved_at = now(),
            updated_at = now()
      WHERE id = $2 AND tenant_id = $3
      RETURNING *`,
    [resolution, id, tenantId]
  );
  return rows[0] ?? null;
}

export async function closeTicket(tenantId: string, id: string): Promise<SupportTicket | null> {
  const { rows } = await query<SupportTicket>(
    `UPDATE support_tickets
        SET status = 'closed', closed_at = now(), updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function setTicketStatus(tenantId: string, id: string, status: TicketStatus): Promise<SupportTicket | null> {
  // Auto-sincroniza timestamps según el estado nuevo (drag&drop Kanban).
  const setResolved = status === "resolved" ? "resolved_at = COALESCE(resolved_at, now())" : "resolved_at = resolved_at";
  const setClosed   = status === "closed"   ? "closed_at   = COALESCE(closed_at, now())"   : "closed_at   = closed_at";
  const { rows } = await query<SupportTicket>(
    `UPDATE support_tickets
        SET status = $1,
            ${setResolved},
            ${setClosed},
            updated_at = now()
      WHERE id = $2 AND tenant_id = $3
      RETURNING *`,
    [status, id, tenantId]
  );
  return rows[0] ?? null;
}

export async function linkKbArticle(tenantId: string, ticketId: string, kbArticleId: string): Promise<void> {
  try {
    await query(
      `UPDATE support_tickets SET kb_article_id = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3`,
      [kbArticleId, ticketId, tenantId]
    );
  } catch (err) {
    logger.warn({ err, ticketId, kbArticleId, tenantId }, "ticket.linkKbArticle fail");
  }
}
