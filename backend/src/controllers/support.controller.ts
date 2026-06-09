import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  createConversation, getConversationById, listConversations, listMessages,
  updateConversation, recordSupportAudit, appendMessage,
} from "../services/support/conversation.service";
import {
  handleFirstMessage, handleUserMessage, welcomeText, manualEscalate,
} from "../services/support/orchestrator.service";
import {
  listTickets, getTicketById, getTicketByCode, assignTicket,
  resolveTicket, closeTicket, linkKbArticle, setTicketStatus,
} from "../services/support/ticket.service";
import {
  createArticle, listArticles, getArticleById, approveArticle,
  archiveArticle, deleteArticle, markHelpful,
} from "../services/support/kb.service";
import { getUserBySession } from "../services/auth.service";
import { emitEventFireAndForget } from "../services/integrations/delivery.service";
import { query } from "../database/db";
import type {
  SupportChannel, SupportStatus, TicketStatus, Priority, KbStatus,
} from "../types/support.types";

const COOKIE = "ams_session";

async function getUserId(req: FastifyRequest): Promise<string | null> {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[COOKIE];
  if (!token) return null;
  const u = await getUserBySession(req.tenantId, token);
  return u?.id ?? null;
}

// =====================================================
// Conversations
// =====================================================
interface StartConvBody {
  channel?: SupportChannel;
  user_name?: string;
  user_email?: string;
  user_phone?: string;
  client?: string;
  initial_message?: string;
}

export async function postStartConversation(
  req: FastifyRequest<{ Body: StartConvBody }>,
  reply: FastifyReply
) {
  try {
    const b = req.body || {};
    const userId = await getUserId(req);
    const conv = await createConversation(req.tenantId, {
      channel: (b.channel ?? "chat") as SupportChannel,
      user_name: b.user_name,
      user_email: b.user_email,
      user_phone: b.user_phone,
      client: b.client,
      created_by: userId ?? undefined,
    });
    await recordSupportAudit(req.tenantId, {
      conversationId: conv.id,
      action: "CONV_STARTED",
      actor: userId ?? "anonymous",
      details: { channel: conv.channel },
    });

    if (b.initial_message && b.initial_message.trim()) {
      const result = await handleFirstMessage(req.tenantId, conv.id, b.initial_message.trim());
      return reply.send({ success: true, conversation: result.conversation, firstResponse: result });
    }
    // Sin mensaje inicial: agregamos saludo del bot
    await appendMessage(req.tenantId, conv.id, "system", welcomeText(), { greeting: true });
    return reply.send({ success: true, conversation: conv, welcome: welcomeText() });
  } catch (err) {
    logger.error({ err }, "support.start fail");
    return reply.code(500).send({ success: false, error: "Error creando conversación" });
  }
}

export async function postSendMessage(
  req: FastifyRequest<{ Params: { id: string }; Body: { text?: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  const text = (req.body?.text ?? "").trim();
  if (!text) return reply.code(400).send({ success: false, error: "text es obligatorio" });
  try {
    const result = await handleUserMessage(req.tenantId, id, text);
    return reply.send({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "support.message fail");
    return reply.code(500).send({ success: false, error: "Error procesando mensaje" });
  }
}

export async function getConversations(
  req: FastifyRequest<{ Querystring: { status?: string; channel?: string } }>,
  reply: FastifyReply
) {
  try {
    const status = (req.query.status as SupportStatus) || undefined;
    const channel = (req.query.channel as SupportChannel) || undefined;
    const data = await listConversations(req.tenantId, { status, channel });
    return reply.send({ success: true, count: data.length, conversations: data });
  } catch (err) {
    logger.error({ err }, "support.list convs fail");
    return reply.code(500).send({ success: false, error: "Error listando conversaciones" });
  }
}

export async function getConversationDetail(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const conv = await getConversationById(req.tenantId, req.params.id);
    if (!conv) return reply.code(404).send({ success: false, error: "no encontrada" });
    const messages = await listMessages(req.tenantId, req.params.id);
    return reply.send({ success: true, conversation: conv, messages });
  } catch (err) {
    logger.error({ err }, "support.conv detail fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postManualEscalate(
  req: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  const reason = (req.body?.reason ?? "").trim();
  try {
    const userId = await getUserId(req);
    let actorLabel: string | undefined;
    if (userId) {
      const u = await getUserBySession(req.tenantId, (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[COOKIE] ?? "");
      actorLabel = u ? `${u.name} (${u.email}, ${u.role})` : userId;
    }
    const ticket = await manualEscalate(req.tenantId, id, { reason: reason || undefined, actor: actorLabel });
    return reply.send({ success: true, ticket });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error escalando manualmente";
    logger.warn({ err, id, reason }, "support.manualEscalate fail");
    return reply.code(400).send({ success: false, error: message });
  }
}

export async function postCloseConversation(
  req: FastifyRequest<{ Params: { id: string }; Body: { resolved?: boolean } }>,
  reply: FastifyReply
) {
  try {
    await updateConversation(req.tenantId, req.params.id, {
      status: req.body?.resolved ? "resolved" : "closed",
      closed_at: new Date().toISOString(),
    });
    await recordSupportAudit(req.tenantId, {
      conversationId: req.params.id,
      action: "CONV_CLOSED",
      actor: (await getUserId(req)) ?? "system",
      details: { resolved: !!req.body?.resolved },
    });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "support.close conv fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

// =====================================================
// Tickets de mesa
// =====================================================
export async function getTicketsRoute(
  req: FastifyRequest<{ Querystring: { status?: TicketStatus; priority?: Priority; assignedTo?: string } }>,
  reply: FastifyReply
) {
  try {
    const data = await listTickets(req.tenantId, {
      status: req.query.status,
      priority: req.query.priority,
      assignedTo: req.query.assignedTo,
    });
    return reply.send({ success: true, count: data.length, tickets: data });
  } catch (err) {
    logger.error({ err }, "support.list tickets fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function getTicketDetail(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const t = req.params.id.startsWith("MESA-")
      ? await getTicketByCode(req.tenantId, req.params.id)
      : await getTicketById(req.tenantId, req.params.id);
    if (!t) return reply.code(404).send({ success: false, error: "no encontrado" });
    return reply.send({ success: true, ticket: t });
  } catch (err) {
    logger.error({ err }, "support.ticket detail fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postAssignTicket(
  req: FastifyRequest<{ Params: { id: string }; Body: { userId?: string } }>,
  reply: FastifyReply
) {
  try {
    const me = await getUserId(req);
    const target = req.body?.userId || me;
    if (!target) return reply.code(401).send({ success: false, error: "no_session" });
    const t = await assignTicket(req.tenantId, req.params.id, target);
    if (!t) return reply.code(404).send({ success: false, error: "no encontrado" });
    await recordSupportAudit(req.tenantId, {
      ticketId: t.id,
      action: "TICKET_ASSIGNED",
      actor: me ?? "system",
      details: { assigned_to: target },
    });
    return reply.send({ success: true, ticket: t });
  } catch (err) {
    logger.error({ err }, "support.assign ticket fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postResolveTicket(
  req: FastifyRequest<{
    Params: { id: string };
    Body: { resolution?: string; create_kb_article?: boolean };
  }>,
  reply: FastifyReply
) {
  try {
    const me = await getUserId(req);
    const resolution = (req.body?.resolution || "").trim();
    if (!resolution) return reply.code(400).send({ success: false, error: "resolution requerida" });
    const t = await resolveTicket(req.tenantId, req.params.id, resolution);
    if (!t) return reply.code(404).send({ success: false, error: "no encontrado" });

    let kbArticle = null;
    if (req.body?.create_kb_article) {
      kbArticle = await createArticle(req.tenantId, {
        title: t.title,
        problem: t.summary,
        solution: resolution,
        system: t.system_affected ?? undefined,
        category: t.category ?? undefined,
        source: "from_ticket",
        source_ticket_id: t.id,
        created_by: me ?? undefined,
      });
      await linkKbArticle(req.tenantId, t.id, kbArticle.id);
      await recordSupportAudit(req.tenantId, {
        ticketId: t.id,
        action: "KB_ARTICLE_CREATED",
        actor: me ?? "system",
        details: { articleId: kbArticle.id, status: kbArticle.status },
      });
    }

    await recordSupportAudit(req.tenantId, {
      ticketId: t.id,
      action: "TICKET_RESOLVED",
      actor: me ?? "system",
    });

    // Si la conversación sigue abierta, marcarla como resuelta
    if (t.conversation_id) {
      await updateConversation(req.tenantId, t.conversation_id, {
        status: "resolved",
        closed_at: new Date().toISOString(),
      });
    }

    emitEventFireAndForget("ticket.resolved", {
      code: t.code,
      title: t.title,
      system_affected: t.system_affected,
      priority: t.priority,
      resolution: resolution.slice(0, 500),
      kb_article_created: !!kbArticle,
    });
    if (kbArticle) {
      emitEventFireAndForget("kb.created", {
        title: kbArticle.title,
        system: kbArticle.system,
        source: kbArticle.source,
        status: kbArticle.status,
      });
    }

    return reply.send({ success: true, ticket: t, kbArticle });
  } catch (err) {
    logger.error({ err }, "support.resolve ticket fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

// PATCH genérico de status (usado por Kanban drag&drop)
export async function patchTicketStatus(
  req: FastifyRequest<{ Params: { id: string }; Body: { status?: TicketStatus } }>,
  reply: FastifyReply
) {
  const status = req.body?.status;
  if (!status) return reply.code(400).send({ success: false, error: "status obligatorio" });
  const valid: TicketStatus[] = ["new", "in_progress", "waiting_customer", "resolved", "closed"];
  if (!valid.includes(status)) return reply.code(400).send({ success: false, error: "status inválido" });
  try {
    const me = await getUserId(req);
    const t = await setTicketStatus(req.tenantId, req.params.id, status);
    if (!t) return reply.code(404).send({ success: false, error: "no encontrado" });
    await recordSupportAudit(req.tenantId, {
      ticketId: t.id,
      action: `TICKET_STATUS_${status.toUpperCase()}`,
      actor: me ?? "system",
    });
    return reply.send({ success: true, ticket: t });
  } catch (err) {
    logger.error({ err }, "support.patch status fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postCloseTicket(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const me = await getUserId(req);
    const t = await closeTicket(req.tenantId, req.params.id);
    if (!t) return reply.code(404).send({ success: false, error: "no encontrado" });
    await recordSupportAudit(req.tenantId, {
      ticketId: t.id,
      action: "TICKET_CLOSED",
      actor: me ?? "system",
    });
    emitEventFireAndForget("ticket.closed", {
      code: t.code,
      title: t.title,
      system_affected: t.system_affected,
    });
    return reply.send({ success: true, ticket: t });
  } catch (err) {
    logger.error({ err }, "support.close ticket fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

// =====================================================
// KB
// =====================================================
export async function getKbArticles(
  req: FastifyRequest<{ Querystring: { status?: KbStatus; system?: string; category?: string } }>,
  reply: FastifyReply
) {
  try {
    const data = await listArticles(req.tenantId, {
      status: req.query.status,
      system: req.query.system,
      category: req.query.category,
    });
    return reply.send({ success: true, count: data.length, articles: data });
  } catch (err) {
    logger.error({ err }, "support.kb list fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function getKbArticleDetail(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const a = await getArticleById(req.tenantId, req.params.id);
    if (!a) return reply.code(404).send({ success: false, error: "no encontrado" });
    return reply.send({ success: true, article: a });
  } catch (err) {
    logger.error({ err }, "support.kb detail fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postCreateKb(
  req: FastifyRequest<{ Body: {
    title?: string; problem?: string; solution?: string;
    system?: string; category?: string; tags?: string[];
  } }>,
  reply: FastifyReply
) {
  try {
    const b = req.body || {};
    if (!b.title || !b.problem || !b.solution) {
      return reply.code(400).send({ success: false, error: "title, problem y solution son obligatorios" });
    }
    const me = await getUserId(req);
    const article = await createArticle(req.tenantId, {
      title: b.title,
      problem: b.problem,
      solution: b.solution,
      system: b.system,
      category: b.category,
      tags: b.tags,
      source: "manual",
      created_by: me ?? undefined,
    });
    return reply.send({ success: true, article });
  } catch (err) {
    logger.error({ err }, "support.kb create fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postApproveKb(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const me = await getUserId(req);
    if (!me) return reply.code(401).send({ success: false, error: "no_session" });
    const a = await approveArticle(req.tenantId, req.params.id, me);
    if (!a) return reply.code(404).send({ success: false, error: "no encontrado" });
    await recordSupportAudit(req.tenantId, {
      action: "KB_APPROVED",
      actor: me,
      details: { articleId: a.id },
    });
    emitEventFireAndForget("kb.approved", {
      title: a.title,
      system: a.system,
      category: a.category,
    });
    return reply.send({ success: true, article: a });
  } catch (err) {
    logger.error({ err }, "support.kb approve fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postArchiveKb(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const a = await archiveArticle(req.tenantId, req.params.id);
    if (!a) return reply.code(404).send({ success: false, error: "no encontrado" });
    return reply.send({ success: true, article: a });
  } catch (err) {
    logger.error({ err }, "support.kb archive fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function deleteKb(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const ok = await deleteArticle(req.tenantId, req.params.id);
    if (!ok) return reply.code(404).send({ success: false, error: "no encontrado" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "support.kb delete fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postKbHelpful(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    await markHelpful(req.tenantId, req.params.id);
    return reply.send({ success: true });
  } catch (err) {
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

// =====================================================
// Métricas
// =====================================================
export async function getMetrics(req: FastifyRequest, reply: FastifyReply) {
  try {
    const t = req.tenantId;
    const [convTotal, convByStatus, convByChannel, aiResolvedRate, tktByStatus, tktByPriority, slaBreaches, kbStats] = await Promise.all([
      query<{ c: string }>("SELECT count(*)::text AS c FROM support_conversations WHERE tenant_id = $1", [t]),
      query<{ status: string; c: string }>("SELECT status, count(*)::text AS c FROM support_conversations WHERE tenant_id = $1 GROUP BY status", [t]),
      query<{ channel: string; c: string }>("SELECT channel, count(*)::text AS c FROM support_conversations WHERE tenant_id = $1 GROUP BY channel", [t]),
      query<{ c: string; r: string }>("SELECT count(*)::text AS c, sum(CASE WHEN ai_resolved THEN 1 ELSE 0 END)::text AS r FROM support_conversations WHERE tenant_id = $1 AND status IN ('resolved','closed')", [t]),
      query<{ status: string; c: string }>("SELECT status, count(*)::text AS c FROM support_tickets WHERE tenant_id = $1 GROUP BY status", [t]),
      query<{ priority: string; c: string }>("SELECT priority, count(*)::text AS c FROM support_tickets WHERE tenant_id = $1 GROUP BY priority", [t]),
      query<{ c: string }>("SELECT count(*)::text AS c FROM support_tickets WHERE tenant_id = $1 AND sla_due_at IS NOT NULL AND sla_due_at < now() AND status NOT IN ('resolved','closed')", [t]),
      query<{ status: string; c: string }>("SELECT status, count(*)::text AS c FROM kb_articles WHERE tenant_id = $1 GROUP BY status", [t]),
    ]);
    const totalClosed = Number(aiResolvedRate.rows[0]?.c ?? 0);
    const resolved   = Number(aiResolvedRate.rows[0]?.r ?? 0);
    return reply.send({
      success: true,
      conversations: {
        total: Number(convTotal.rows[0]?.c ?? 0),
        byStatus: convByStatus.rows.map((r) => ({ key: r.status, count: Number(r.c) })),
        byChannel: convByChannel.rows.map((r) => ({ key: r.channel, count: Number(r.c) })),
      },
      aiResolution: {
        closedConversations: totalClosed,
        resolvedByAi: resolved,
        rate: totalClosed > 0 ? Math.round((resolved / totalClosed) * 100) : 0,
      },
      tickets: {
        byStatus: tktByStatus.rows.map((r) => ({ key: r.status, count: Number(r.c) })),
        byPriority: tktByPriority.rows.map((r) => ({ key: r.priority, count: Number(r.c) })),
        slaBreaches: Number(slaBreaches.rows[0]?.c ?? 0),
      },
      kb: {
        byStatus: kbStats.rows.map((r) => ({ key: r.status, count: Number(r.c) })),
      },
    });
  } catch (err) {
    logger.error({ err }, "support.metrics fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}
