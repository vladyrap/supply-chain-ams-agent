// =============================================================================
// custom-agents.controller.ts — v1.3 Agent Hub
// =============================================================================

import type { FastifyReply, FastifyRequest } from "fastify";
import * as svc from "../services/custom-agents.service";
import { recordAudit } from "../services/audit.service";
import { logger } from "../utils/logger";

type Req = FastifyRequest & { tenantId: string };

export async function getAgents(req: FastifyRequest, reply: FastifyReply) {
  const r = req as Req;
  const q = (req.query || {}) as {
    category?: string;
    createdBy?: string;
    verified?: string;
    search?: string;
    forUser?: string;
  };
  try {
    const agents = await svc.listAgents(r.tenantId, {
      category: q.category,
      createdBy: q.createdBy,
      verifiedOnly: q.verified === "true",
      search: q.search,
      forUser: q.forUser,
    });
    return reply.send({ success: true, count: agents.length, agents });
  } catch (err) {
    logger.error({ err }, "agents.list fail");
    return reply.code(500).send({ success: false, error: "Error listando agentes" });
  }
}

export async function getAgentById(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const q = (req.query || {}) as { forUser?: string };
  try {
    const agent = await svc.getAgent(r.tenantId, req.params.id);
    if (!agent) return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    // Un borrador ajeno no se expone (mismas señales que un id inexistente).
    if (
      !agent.isVerified &&
      agent.visibility === "private" &&
      agent.createdBy &&
      q.forUser !== undefined &&
      agent.createdBy !== q.forUser
    ) {
      return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    }
    return reply.send({ success: true, agent });
  } catch (err) {
    logger.error({ err }, "agents.get fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo agente" });
  }
}

// ── Publicación (onda 4) ──

export async function postAgentPublish(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const b = (req.body || {}) as { user?: string };
  const user = (b.user ?? "").toString().trim();
  if (!user) return reply.code(400).send({ success: false, error: "user es obligatorio" });
  try {
    const agent = await svc.publishAgent(r.tenantId, req.params.id, user);
    await recordAudit(r.tenantId, "CUSTOM_AGENT_PUBLISHED", {
      agentId: agent.id, name: agent.name, publishedBy: user,
    }).catch(() => null);
    return reply.send({ success: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /no encontrado/.test(msg) ? 404
      : /Solo el creador|verificados/.test(msg) ? 403
      : /instrucciones|descripción/.test(msg) ? 400 : 500;
    logger.error({ err }, "agents.publish fail");
    return reply.code(code).send({ success: false, error: msg });
  }
}

export async function postAgentUnpublish(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const b = (req.body || {}) as { user?: string };
  const user = (b.user ?? "").toString().trim();
  if (!user) return reply.code(400).send({ success: false, error: "user es obligatorio" });
  try {
    const agent = await svc.unpublishAgent(r.tenantId, req.params.id, user);
    await recordAudit(r.tenantId, "CUSTOM_AGENT_UNPUBLISHED", {
      agentId: agent.id, name: agent.name, unpublishedBy: user,
    }).catch(() => null);
    return reply.send({ success: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /no encontrado/.test(msg) ? 404
      : /Solo el creador|verificados/.test(msg) ? 403 : 500;
    logger.error({ err }, "agents.unpublish fail");
    return reply.code(code).send({ success: false, error: msg });
  }
}

export async function postAgent(req: FastifyRequest, reply: FastifyReply) {
  const r = req as Req;
  const b = (req.body || {}) as Partial<svc.CreateAgentInput>;
  if (!b.name?.trim() || !b.instructions?.trim()) {
    return reply.code(400).send({
      success: false,
      error: "name e instructions son obligatorios",
    });
  }
  try {
    const agent = await svc.createAgent(r.tenantId, {
      name: b.name,
      category: b.category ?? "GENERAL",
      description: b.description,
      instructions: b.instructions,
      kbModules: b.kbModules,
      icon: b.icon,
      visibility: b.visibility,
      createdBy: b.createdBy ?? null,
    });
    await recordAudit(r.tenantId, "CUSTOM_AGENT_CREATED", {
      agentId: agent.id, name: agent.name, category: agent.category,
      createdBy: agent.createdBy,
    }).catch(() => null);
    return reply.code(201).send({ success: true, agent });
  } catch (err) {
    logger.error({ err }, "agents.create fail");
    return reply.code(500).send({ success: false, error: (err as Error).message });
  }
}

export async function putAgent(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  try {
    const agent = await svc.updateAgent(
      r.tenantId,
      req.params.id,
      (req.body || {}) as Partial<svc.CreateAgentInput>,
    );
    if (!agent) return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    return reply.send({ success: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /verificados/.test(msg) ? 403 : 500;
    logger.error({ err }, "agents.update fail");
    return reply.code(code).send({ success: false, error: msg });
  }
}

export async function deleteAgentById(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  try {
    const ok = await svc.deleteAgent(r.tenantId, req.params.id);
    if (!ok) return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    await recordAudit(r.tenantId, "CUSTOM_AGENT_DELETED", { agentId: req.params.id }).catch(() => null);
    return reply.send({ success: true });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /verificados/.test(msg) ? 403 : 500;
    logger.error({ err }, "agents.delete fail");
    return reply.code(code).send({ success: false, error: msg });
  }
}

export async function postAgentRating(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const b = (req.body || {}) as { stars?: number };
  const stars = Number(b.stars);
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
    return reply.code(400).send({ success: false, error: "stars debe ser 1-5" });
  }
  try {
    const agent = await svc.rateAgent(r.tenantId, req.params.id, stars);
    if (!agent) return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    return reply.send({ success: true, agent });
  } catch (err) {
    logger.error({ err }, "agents.rate fail");
    return reply.code(500).send({ success: false, error: "Error registrando rating" });
  }
}

export async function postAgentChat(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const b = (req.body || {}) as {
    message?: string;
    user?: string;
    client?: string;
    environment?: string;
    conversationId?: string;
  };
  const message = (b.message ?? "").trim();
  if (!message) {
    return reply.code(400).send({ success: false, error: "message es obligatorio" });
  }
  if (message.length > 8000) {
    return reply.code(400).send({ success: false, error: "message supera 8000 caracteres" });
  }
  try {
    const { agent, result, conversationId } = await svc.chatWithCustomAgent(r.tenantId, req.params.id, {
      message,
      user: (b.user ?? "anonymous").toString(),
      client: b.client,
      environment: b.environment,
      conversationId: b.conversationId,
    });
    return reply.send({
      success: true,
      agent: { id: agent.id, name: agent.name, category: agent.category, icon: agent.icon },
      response: result.text,
      conversationId,
      metadata: {
        model: result.model,
        confidence: result.confidence,
        ragSources: result.ragSources,
        responseId: result.responseId,
      },
    });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /no encontrado/.test(msg) ? 404
      : /archivado/.test(msg) ? 409
      : /borrador privado/.test(msg) ? 403 : 500;
    logger.error({ err, agentId: req.params.id }, "agents.chat fail");
    return reply.code(code).send({ success: false, error: msg });
  }
}

// ============================================================
// Conversaciones
// ============================================================

export async function getAgentConversations(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const q = (req.query || {}) as { user?: string };
  const userId = (q.user ?? "anonymous").toString();
  try {
    const conv = await import("../services/agent-conversations.service");
    const conversations = await conv.listConversations(r.tenantId, req.params.id, userId);
    return reply.send({ success: true, conversations });
  } catch (err) {
    logger.error({ err }, "agents.conversations fail");
    return reply.code(500).send({ success: false, error: "Error listando conversaciones" });
  }
}

export async function getConversationById(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  try {
    const conv = await import("../services/agent-conversations.service");
    const data = await conv.getConversation(r.tenantId, req.params.id);
    if (!data) return reply.code(404).send({ success: false, error: "Conversación no encontrada" });
    return reply.send({ success: true, ...data });
  } catch (err) {
    logger.error({ err }, "conversations.get fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo conversación" });
  }
}

export async function deleteConversationById(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const q = (req.query || {}) as { user?: string };
  try {
    const conv = await import("../services/agent-conversations.service");
    const ok = await conv.deleteConversation(r.tenantId, req.params.id, (q.user ?? "anonymous").toString());
    if (!ok) return reply.code(404).send({ success: false, error: "Conversación no encontrada" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "conversations.delete fail");
    return reply.code(500).send({ success: false, error: "Error eliminando conversación" });
  }
}
