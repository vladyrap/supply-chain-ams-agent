import { query } from "../../database/db";
import type {
  SupportConversation,
  SupportMessage,
  SupportChannel,
  MessageRole,
  SupportStatus,
  Urgency,
} from "../../types/support.types";

export interface CreateConvInput {
  channel: SupportChannel;
  user_name?: string;
  user_email?: string;
  user_phone?: string;
  client?: string;
  created_by?: string;
}

export async function createConversation(tenantId: string, input: CreateConvInput): Promise<SupportConversation> {
  const { rows } = await query<SupportConversation>(
    `INSERT INTO support_conversations
       (tenant_id, channel, user_name, user_email, user_phone, client, created_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
     RETURNING *`,
    [
      tenantId,
      input.channel,
      input.user_name ?? null,
      input.user_email ?? null,
      input.user_phone ?? null,
      input.client ?? null,
      input.created_by ?? null,
    ]
  );
  return rows[0]!;
}

export async function getConversationById(tenantId: string, id: string): Promise<SupportConversation | null> {
  const { rows } = await query<SupportConversation>(
    `SELECT * FROM support_conversations WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function listConversations(tenantId: string, filters: {
  status?: SupportStatus;
  channel?: SupportChannel;
  limit?: number;
} = {}): Promise<SupportConversation[]> {
  const conds: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  if (filters.status)  { params.push(filters.status);  conds.push(`status = $${params.length}`); }
  if (filters.channel) { params.push(filters.channel); conds.push(`channel = $${params.length}`); }
  const where = `WHERE ${conds.join(" AND ")}`;
  const limit = Math.min(filters.limit ?? 100, 200);
  params.push(limit);
  const { rows } = await query<SupportConversation>(
    `SELECT * FROM support_conversations ${where}
       ORDER BY updated_at DESC
       LIMIT $${params.length}`,
    params
  );
  return rows;
}

export async function listMessages(tenantId: string, conversationId: string): Promise<SupportMessage[]> {
  const { rows } = await query<SupportMessage>(
    `SELECT m.* FROM support_messages m
       JOIN support_conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = $1 AND c.tenant_id = $2
       ORDER BY m.created_at ASC`,
    [conversationId, tenantId]
  );
  return rows;
}

export async function appendMessage(
  tenantId: string,
  conversationId: string,
  role: MessageRole,
  text: string,
  metadata: Record<string, unknown> = {}
): Promise<SupportMessage> {
  // Validar que la conversación pertenezca al tenant antes de insertar mensaje.
  const conv = await query<{ id: string }>(
    `SELECT id FROM support_conversations WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId]
  );
  if (conv.rows.length === 0) {
    throw new Error(`Conversación ${conversationId} no pertenece al tenant ${tenantId}`);
  }
  const { rows } = await query<SupportMessage>(
    `INSERT INTO support_messages (conversation_id, role, text, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [conversationId, role, text, JSON.stringify(metadata)]
  );
  // Bump message_count + updated_at (también scopeado)
  await query(
    `UPDATE support_conversations
        SET message_count = message_count + 1,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId]
  );
  return rows[0]!;
}

export interface UpdateConvFields {
  status?: SupportStatus;
  intent?: string;
  sap_module?: string;
  urgency?: Urgency;
  category?: string;
  summary?: string;
  ai_resolved?: boolean;
  escalated_to_ticket?: string;
  closed_at?: string | null;
}

export async function updateConversation(tenantId: string, id: string, fields: UpdateConvFields): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (fields.status !== undefined) push("status", fields.status);
  if (fields.intent !== undefined) push("intent", fields.intent);
  if (fields.sap_module !== undefined) push("sap_module", fields.sap_module);
  if (fields.urgency !== undefined) push("urgency", fields.urgency);
  if (fields.category !== undefined) push("category", fields.category);
  if (fields.summary !== undefined) push("summary", fields.summary);
  if (fields.ai_resolved !== undefined) push("ai_resolved", fields.ai_resolved);
  if (fields.escalated_to_ticket !== undefined) push("escalated_to_ticket", fields.escalated_to_ticket);
  if (fields.closed_at !== undefined) push("closed_at", fields.closed_at);
  if (sets.length === 0) return;
  sets.push(`updated_at = now()`);
  params.push(id);
  const idIdx = params.length;
  params.push(tenantId);
  const tenantIdx = params.length;
  await query(
    `UPDATE support_conversations SET ${sets.join(", ")} WHERE id = $${idIdx} AND tenant_id = $${tenantIdx}`,
    params
  );
}

export async function recordSupportAudit(
  tenantId: string,
  data: {
    conversationId?: string;
    ticketId?: string;
    action: string;
    actor?: string;
    details?: object;
  }
): Promise<void> {
  await query(
    `INSERT INTO support_audit (tenant_id, conversation_id, ticket_id, action, actor, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      tenantId,
      data.conversationId ?? null,
      data.ticketId ?? null,
      data.action,
      data.actor ?? null,
      JSON.stringify(data.details ?? {}),
    ]
  );
}
