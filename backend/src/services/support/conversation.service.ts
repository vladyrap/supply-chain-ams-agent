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

export async function createConversation(input: CreateConvInput): Promise<SupportConversation> {
  const { rows } = await query<SupportConversation>(
    `INSERT INTO support_conversations
       (channel, user_name, user_email, user_phone, client, created_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open')
     RETURNING *`,
    [
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

export async function getConversationById(id: string): Promise<SupportConversation | null> {
  const { rows } = await query<SupportConversation>(
    `SELECT * FROM support_conversations WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listConversations(filters: {
  status?: SupportStatus;
  channel?: SupportChannel;
  limit?: number;
} = {}): Promise<SupportConversation[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.status)  { params.push(filters.status);  conds.push(`status = $${params.length}`); }
  if (filters.channel) { params.push(filters.channel); conds.push(`channel = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
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

export async function listMessages(conversationId: string): Promise<SupportMessage[]> {
  const { rows } = await query<SupportMessage>(
    `SELECT * FROM support_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
    [conversationId]
  );
  return rows;
}

export async function appendMessage(
  conversationId: string,
  role: MessageRole,
  text: string,
  metadata: Record<string, unknown> = {}
): Promise<SupportMessage> {
  const { rows } = await query<SupportMessage>(
    `INSERT INTO support_messages (conversation_id, role, text, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [conversationId, role, text, JSON.stringify(metadata)]
  );
  // Bump message_count + updated_at
  await query(
    `UPDATE support_conversations
        SET message_count = message_count + 1,
            updated_at = now()
      WHERE id = $1`,
    [conversationId]
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

export async function updateConversation(id: string, fields: UpdateConvFields): Promise<void> {
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
  await query(
    `UPDATE support_conversations SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  );
}

export async function recordSupportAudit(
  data: {
    conversationId?: string;
    ticketId?: string;
    action: string;
    actor?: string;
    details?: object;
  }
): Promise<void> {
  await query(
    `INSERT INTO support_audit (conversation_id, ticket_id, action, actor, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      data.conversationId ?? null,
      data.ticketId ?? null,
      data.action,
      data.actor ?? null,
      JSON.stringify(data.details ?? {}),
    ]
  );
}
