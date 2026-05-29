import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  createFeedback, listFeedback, getFeedbackStats,
  type FeedbackKind, type FeedbackSource,
} from "../services/feedback.service";
import { getUserBySession } from "../services/auth.service";
import { query } from "../database/db";
import type { SupportConversation, SupportMessage } from "../types/support.types";

const COOKIE = "ams_session";

async function getUserId(req: FastifyRequest): Promise<string | null> {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[COOKIE];
  if (!token) return null;
  const u = await getUserBySession(token);
  return u?.id ?? null;
}

// =====================================================
// POST /api/agent-lab/feedback
// =====================================================
interface PostFeedbackBody {
  source?: string;
  kind?: string;
  reason?: string;
  conversationId?: string;
  messageId?: string;
  ticketId?: string;
  query?: string;
  response?: string;
  metadata?: Record<string, unknown>;
}

const VALID_SOURCES: FeedbackSource[] = ["support", "agent_chat", "voice", "other"];
const VALID_KINDS: FeedbackKind[] = ["positive", "negative"];

export async function postFeedback(
  req: FastifyRequest<{ Body: PostFeedbackBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.source || !VALID_SOURCES.includes(b.source as FeedbackSource)) {
    return reply.code(400).send({ success: false, error: "source inválido (support, agent_chat, voice, other)" });
  }
  if (!b.kind || !VALID_KINDS.includes(b.kind as FeedbackKind)) {
    return reply.code(400).send({ success: false, error: "kind inválido (positive o negative)" });
  }
  try {
    const userId = await getUserId(req);
    const row = await createFeedback({
      source: b.source as FeedbackSource,
      kind: b.kind as FeedbackKind,
      reason: b.reason?.trim() || null,
      conversationId: b.conversationId || null,
      messageId: b.messageId || null,
      ticketId: b.ticketId || null,
      query: b.query?.slice(0, 4000) || null,
      response: b.response?.slice(0, 16000) || null,
      metadata: b.metadata ?? {},
      createdBy: userId,
    });
    return reply.send({ success: true, feedback: row });
  } catch (err) {
    logger.error({ err }, "feedback.post fail");
    return reply.code(500).send({ success: false, error: "Error registrando feedback" });
  }
}

// =====================================================
// GET /api/agent-lab/feedback
// =====================================================
interface ListQuery {
  source?: string;
  kind?: string;
  conversationId?: string;
  limit?: string;
}

export async function getFeedbackList(
  req: FastifyRequest<{ Querystring: ListQuery }>,
  reply: FastifyReply
) {
  try {
    const q = req.query || {};
    const rows = await listFeedback({
      source: VALID_SOURCES.includes(q.source as FeedbackSource) ? (q.source as FeedbackSource) : undefined,
      kind:   VALID_KINDS.includes(q.kind as FeedbackKind) ? (q.kind as FeedbackKind) : undefined,
      conversationId: q.conversationId,
      limit: q.limit ? parseInt(q.limit, 10) : 100,
    });
    return reply.send({ success: true, count: rows.length, feedback: rows });
  } catch (err) {
    logger.error({ err }, "feedback.list fail");
    return reply.code(500).send({ success: false, error: "Error listando feedback" });
  }
}

// =====================================================
// GET /api/agent-lab/feedback/stats
// =====================================================
export async function getFeedbackStatsRoute(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const stats = await getFeedbackStats();
    return reply.send({ success: true, stats });
  } catch (err) {
    logger.error({ err }, "feedback.stats fail");
    return reply.code(500).send({ success: false, error: "Error calculando stats" });
  }
}

// =====================================================
// GET /api/agent-lab/conversations/:id/trace
// Devuelve toda la traza de la conversación para replay:
// conversación + mensajes + feedback asociado + ticket si se escaló
// =====================================================
export async function getConversationTrace(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return reply.code(400).send({ success: false, error: "ID inválido" });
  }
  try {
    const { rows: convRows } = await query<SupportConversation>(
      `SELECT * FROM support_conversations WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (convRows.length === 0) {
      return reply.code(404).send({ success: false, error: "Conversación no encontrada" });
    }
    const conv = convRows[0];
    const { rows: msgs } = await query<SupportMessage>(
      `SELECT * FROM support_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    const feedback = await listFeedback({ conversationId: id, limit: 200 });
    let ticket = null;
    if (conv.escalated_to_ticket) {
      const { rows: tk } = await query(
        `SELECT id, code, title, summary, status, priority, sla_minutes, sla_due_at, created_at, resolved_at, closed_at, assigned_role
         FROM support_tickets WHERE id = $1 LIMIT 1`,
        [conv.escalated_to_ticket]
      );
      ticket = tk[0] ?? null;
    }
    return reply.send({
      success: true,
      conversation: conv,
      messages: msgs,
      feedback,
      ticket,
    });
  } catch (err) {
    logger.error({ err, id }, "conversation.trace fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo traza" });
  }
}
