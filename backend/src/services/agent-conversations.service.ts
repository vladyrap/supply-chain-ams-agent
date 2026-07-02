// =============================================================================
// agent-conversations.service.ts — v1.3 Agent Hub
// =============================================================================
// Historial persistente de conversaciones con agentes custom:
//   - agent_conversations: 1 por hilo (user × agente)
//   - agent_messages: mensajes user/agent con metadata (modelo, confianza, RAG)
//   - buildHistoryBlock(): últimos N turnos formateados para el prompt,
//     así el agente mantiene contexto multi-turn sin tocar claude.service.
// =============================================================================

import { query } from "../database/db";

export interface AgentConversation {
  id: string;
  tenantId: string;
  agentId: string;
  userId: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  conversationId: string;
  role: "user" | "agent";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS agent_conversations (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id  TEXT NOT NULL DEFAULT 'default',
      agent_id   UUID NOT NULL,
      user_id    TEXT NOT NULL,
      title      TEXT NOT NULL DEFAULT 'Nueva conversación',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       TEXT NOT NULL DEFAULT 'default',
      conversation_id UUID NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_conv_tenant ON agent_conversations(tenant_id, agent_id, user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_msg_conv ON agent_messages(conversation_id, created_at)`);
  schemaEnsured = true;
}

interface ConvRow {
  id: string; tenant_id: string; agent_id: string; user_id: string;
  title: string; message_count?: string; created_at: string; updated_at: string;
}
interface MsgRow {
  id: string; conversation_id: string; role: string; content: string;
  metadata: Record<string, unknown>; created_at: string;
}

function mapConv(r: ConvRow): AgentConversation {
  return {
    id: r.id, tenantId: r.tenant_id, agentId: r.agent_id, userId: r.user_id,
    title: r.title, messageCount: Number(r.message_count ?? 0),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapMsg(r: MsgRow): AgentMessage {
  return {
    id: r.id, conversationId: r.conversation_id,
    role: r.role as AgentMessage["role"], content: r.content,
    metadata: r.metadata ?? {}, createdAt: r.created_at,
  };
}

export async function listConversations(
  tenantId: string, agentId: string, userId: string,
): Promise<AgentConversation[]> {
  await ensureSchema();
  const { rows } = await query<ConvRow>(
    `SELECT c.*, (SELECT count(*) FROM agent_messages m WHERE m.conversation_id = c.id)::text AS message_count
       FROM agent_conversations c
      WHERE c.tenant_id = $1 AND c.agent_id = $2 AND c.user_id = $3
      ORDER BY c.updated_at DESC
      LIMIT 50`,
    [tenantId, agentId, userId],
  );
  return rows.map(mapConv);
}

export async function getConversation(
  tenantId: string, conversationId: string,
): Promise<{ conversation: AgentConversation; messages: AgentMessage[] } | null> {
  await ensureSchema();
  const { rows } = await query<ConvRow>(
    `SELECT * FROM agent_conversations WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId],
  );
  if (!rows[0]) return null;
  const msgs = await query<MsgRow>(
    `SELECT * FROM agent_messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 200`,
    [conversationId],
  );
  return { conversation: mapConv(rows[0]), messages: msgs.rows.map(mapMsg) };
}

export async function createConversation(
  tenantId: string, agentId: string, userId: string, firstMessage: string,
): Promise<AgentConversation> {
  await ensureSchema();
  const title = firstMessage.trim().slice(0, 60) + (firstMessage.length > 60 ? "…" : "");
  const { rows } = await query<ConvRow>(
    `INSERT INTO agent_conversations (tenant_id, agent_id, user_id, title)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [tenantId, agentId, userId, title || "Nueva conversación"],
  );
  return mapConv(rows[0]!);
}

export async function appendMessage(
  tenantId: string, conversationId: string,
  role: "user" | "agent", content: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO agent_messages (tenant_id, conversation_id, role, content, metadata)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [tenantId, conversationId, role, content, JSON.stringify(metadata)],
  );
  await query(
    `UPDATE agent_conversations SET updated_at = now() WHERE id = $1`,
    [conversationId],
  );
}

export async function deleteConversation(
  tenantId: string, conversationId: string, userId: string,
): Promise<boolean> {
  await ensureSchema();
  const res = await query(
    `DELETE FROM agent_conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [conversationId, tenantId, userId],
  );
  await query(`DELETE FROM agent_messages WHERE conversation_id = $1`, [conversationId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Últimos N turnos formateados para inyectar en el prompt — así el agente
 * mantiene contexto multi-turn. Devuelve "" si no hay historial.
 */
export async function buildHistoryBlock(
  tenantId: string, conversationId: string, maxTurns = 8,
): Promise<string> {
  await ensureSchema();
  const { rows } = await query<MsgRow>(
    `SELECT * FROM (
       SELECT * FROM agent_messages
        WHERE conversation_id = $1 AND tenant_id = $2
        ORDER BY created_at DESC LIMIT $3
     ) sub ORDER BY created_at ASC`,
    [conversationId, tenantId, maxTurns * 2],
  );
  if (rows.length === 0) return "";
  const lines = rows.map((m) =>
    `${m.role === "user" ? "Usuario" : "Agente"}: ${m.content.slice(0, 800)}`);
  return `HISTORIAL DE LA CONVERSACIÓN (contexto previo, no repetir):\n${lines.join("\n")}\n---\n`;
}
