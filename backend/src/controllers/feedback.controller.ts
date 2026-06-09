import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  createFeedback, listFeedback, getFeedbackStats,
  type FeedbackKind, type FeedbackSource,
} from "../services/feedback.service";
import { getUserBySession } from "../services/auth.service";
import { query } from "../database/db";
import type { SupportConversation, SupportMessage } from "../types/support.types";
import {
  listConvertibleTickets, draftKbFromTicket, runPlayground,
  adoptPrompt, getActivePrompt, listPromptVersions, activatePromptVersion,
} from "../services/agent-lab.service";
import { createArticle } from "../services/support/kb.service";

const COOKIE = "ams_session";

async function getUserId(req: FastifyRequest): Promise<string | null> {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[COOKIE];
  if (!token) return null;
  const u = await getUserBySession(req.tenantId, token);
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
  responseId?: string;          // <- vincula con agent_response_provenance
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
      metadata: { ...(b.metadata ?? {}), responseId: b.responseId ?? null },
      createdBy: userId,
    });
    // Loop de aprendizaje: si el feedback referencia un responseId,
    // ajustamos scores de los items/Q&A usados en esa respuesta.
    let learning: { itemsTouched: number; qasTouched: number } | null = null;
    if (b.responseId) {
      try {
        const { adjustScoreFromFeedback } = await import("../services/provenance.service");
        learning = await adjustScoreFromFeedback(req.tenantId, b.responseId, b.kind as FeedbackKind);
      } catch (err) {
        logger.debug({ err }, "adjustScoreFromFeedback fail (continuo)");
      }
    }
    return reply.send({ success: true, feedback: row, learning });
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

// =====================================================
// WIZARD: ticket → KB draft
// =====================================================

export async function getConvertibleTickets(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const tickets = await listConvertibleTickets(80);
    return reply.send({ success: true, count: tickets.length, tickets });
  } catch (err) {
    logger.error({ err }, "wizard.listTickets fail");
    return reply.code(500).send({ success: false, error: "Error listando tickets" });
  }
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function postWizardDraft(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) {
    return reply.code(400).send({ success: false, error: "ID inválido" });
  }
  try {
    const result = await draftKbFromTicket(id);
    return reply.send({ success: true, ...result });
  } catch (err) {
    logger.error({ err, id }, "wizard.draft fail");
    const msg = err instanceof Error ? err.message : "Error generando draft";
    return reply.code(500).send({ success: false, error: msg });
  }
}

interface WizardCommitBody {
  ticketId?: string;
  title?: string;
  problem?: string;
  solution?: string;
  category?: string;
  system?: string;
  tags?: string[];
}

export async function postWizardCommit(
  req: FastifyRequest<{ Body: WizardCommitBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.title?.trim() || !b.problem?.trim() || !b.solution?.trim()) {
    return reply.code(400).send({ success: false, error: "title, problem y solution son obligatorios" });
  }
  try {
    const userId = await getUserId(req);
    const article = await createArticle(req.tenantId, {
      title: b.title.trim().slice(0, 200),
      problem: b.problem.trim(),
      solution: b.solution.trim(),
      category: b.category?.trim() || undefined,
      system: b.system?.trim() || undefined,
      tags: Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === "string" && t.trim()).slice(0, 8) : [],
      source: b.ticketId ? "from_ticket" : "manual",
      source_ticket_id: b.ticketId && UUID_RX.test(b.ticketId) ? b.ticketId : undefined,
      created_by: userId ?? undefined,
    });
    return reply.send({ success: true, article });
  } catch (err) {
    logger.error({ err }, "wizard.commit fail");
    return reply.code(500).send({ success: false, error: "Error guardando artículo" });
  }
}

// =====================================================
// PLAYGROUND
// =====================================================
interface PlaygroundBody {
  systemPrompt?: string;
  query?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export async function postPlaygroundRun(
  req: FastifyRequest<{ Body: PlaygroundBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.systemPrompt?.trim() || !b.query?.trim()) {
    return reply.code(400).send({ success: false, error: "systemPrompt y query son obligatorios" });
  }
  try {
    const result = await runPlayground({
      systemPrompt: b.systemPrompt,
      query: b.query,
      temperature: typeof b.temperature === "number" ? b.temperature : undefined,
      maxOutputTokens: typeof b.maxOutputTokens === "number" ? b.maxOutputTokens : undefined,
    });
    return reply.send({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "playground.run fail");
    const msg = err instanceof Error ? err.message : "Error ejecutando playground";
    return reply.code(500).send({ success: false, error: msg });
  }
}

// =====================================================
// PROMPT VERSIONING — adoptar variante del Playground como activa
// =====================================================
interface AdoptPromptBody {
  label?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  createdBy?: string;
  adoptionNotes?: string;
}

export async function postAdoptPrompt(
  req: FastifyRequest<{ Body: AdoptPromptBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.label?.trim() || !b.systemPrompt?.trim()) {
    return reply.code(400).send({ success: false, error: "label y systemPrompt son obligatorios" });
  }
  try {
    const userId = await getUserId(req);
    const row = await adoptPrompt({
      label: b.label,
      systemPrompt: b.systemPrompt,
      temperature: b.temperature,
      maxTokens: b.maxTokens,
      createdBy: b.createdBy ?? userId ?? "sistema",
      adoptionNotes: b.adoptionNotes,
    });
    return reply.send({ success: true, version: row });
  } catch (err) {
    logger.error({ err }, "prompt.adopt fail");
    return reply.code(500).send({ success: false, error: "Error adoptando prompt" });
  }
}

export async function getActivePromptRoute(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const row = await getActivePrompt();
    return reply.send({ success: true, version: row });
  } catch (err) {
    logger.error({ err }, "prompt.active fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo prompt activo" });
  }
}

export async function listPromptVersionsRoute(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const rows = await listPromptVersions(50);
    return reply.send({ success: true, count: rows.length, versions: rows });
  } catch (err) {
    logger.error({ err }, "prompt.list fail");
    return reply.code(500).send({ success: false, error: "Error listando prompts" });
  }
}

export async function postActivatePromptVersion(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) return reply.code(400).send({ success: false, error: "ID inválido" });
  try {
    const row = await activatePromptVersion(id);
    if (!row) return reply.code(404).send({ success: false, error: "Versión no encontrada" });
    return reply.send({ success: true, version: row });
  } catch (err) {
    logger.error({ err, id }, "prompt.activate fail");
    return reply.code(500).send({ success: false, error: "Error activando versión" });
  }
}
