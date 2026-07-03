// =============================================================================
// custom-agents.controller.ts — v1.3 Agent Hub
// =============================================================================

import type { FastifyReply, FastifyRequest } from "fastify";
import * as svc from "../services/custom-agents.service";
import { recordAudit } from "../services/audit.service";
import { logger } from "../utils/logger";

type Req = FastifyRequest & { tenantId: string };

// Onda 6 — identidad REAL desde la sesión (req.user, inyectado por requireAuth).
// Nunca se confía en user/createdBy/forUser del body o query para ownership.
function actorFrom(req: FastifyRequest): svc.AgentActor {
  return {
    email: req.user?.email ?? "anonymous",
    isAdmin: req.user?.role === "admin",
  };
}

export async function getAgents(req: FastifyRequest, reply: FastifyReply) {
  const r = req as Req;
  const q = (req.query || {}) as {
    category?: string;
    createdBy?: string;
    verified?: string;
    search?: string;
    status?: string;
  };
  try {
    const agents = await svc.listAgents(r.tenantId, {
      category: q.category,
      createdBy: q.createdBy,
      verifiedOnly: q.verified === "true",
      search: q.search,
      // Onda 6: identidad de sesión — ya no se acepta forUser del cliente
      forUser: req.user?.email,
      status: q.status === "archived" ? "archived" : "active",
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
  try {
    const agent = await svc.getAgent(r.tenantId, req.params.id);
    if (!agent) return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    // Un borrador ajeno no se expone (mismas señales que un id inexistente).
    // Onda 6: chequeo SIEMPRE con identidad de sesión; admin ve todo.
    const actor = actorFrom(req);
    if (
      !agent.isVerified &&
      agent.visibility === "private" &&
      agent.createdBy &&
      agent.createdBy !== actor.email &&
      !actor.isAdmin
    ) {
      return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    }
    return reply.send({ success: true, agent });
  } catch (err) {
    logger.error({ err }, "agents.get fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo agente" });
  }
}

// ── Onda 5: catálogo de modelos, duplicar, versiones, comparador ──

export async function getModels(_req: FastifyRequest, reply: FastifyReply) {
  return reply.send({ success: true, models: svc.getModelsCatalog() });
}

export async function postAgentDuplicate(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const actor = actorFrom(req);
  try {
    const agent = await svc.duplicateAgent(r.tenantId, req.params.id, actor);
    await recordAudit(r.tenantId, "CUSTOM_AGENT_DUPLICATED", {
      sourceAgentId: req.params.id, newAgentId: agent.id, duplicatedBy: actor.email,
    }).catch(() => null);
    return reply.code(201).send({ success: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /no encontrado/.test(msg) ? 404 : /Límite/.test(msg) ? 409 : 500;
    logger.error({ err }, "agents.duplicate fail");
    return reply.code(code).send({ success: false, error: msg });
  }
}

export async function getAgentStatsById(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  try {
    const stats = await svc.getAgentStats(r.tenantId, req.params.id);
    return reply.send({ success: true, stats });
  } catch (err) {
    logger.error({ err }, "agents.stats fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo estadísticas" });
  }
}

export async function getAgentVersions(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  try {
    const versions = await svc.listVersions(r.tenantId, req.params.id);
    return reply.send({ success: true, versions });
  } catch (err) {
    logger.error({ err }, "agents.versions fail");
    return reply.code(500).send({ success: false, error: "Error listando versiones" });
  }
}

export async function postAgentRestore(
  req: FastifyRequest<{ Params: { id: string; versionId: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const actor = actorFrom(req);
  try {
    const agent = await svc.restoreVersion(r.tenantId, req.params.id, req.params.versionId, actor);
    await recordAudit(r.tenantId, "CUSTOM_AGENT_VERSION_RESTORED", {
      agentId: agent.id, versionId: req.params.versionId, restoredBy: actor.email, asAdmin: actor.isAdmin,
    }).catch(() => null);
    return reply.send({ success: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /no encontrad/.test(msg) ? 404 : /Solo el creador|verificados/.test(msg) ? 403 : 500;
    logger.error({ err }, "agents.restore fail");
    return reply.code(code).send({ success: false, error: msg });
  }
}

export async function postAgentCompare(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const b = (req.body || {}) as { message?: string; models?: string[] };
  const message = (b.message ?? "").trim();
  if (!message) return reply.code(400).send({ success: false, error: "message es obligatorio" });
  if (message.length > 4000) return reply.code(400).send({ success: false, error: "message supera 4000 caracteres" });
  if (!Array.isArray(b.models) || b.models.length !== 2) {
    return reply.code(400).send({ success: false, error: "models debe ser un array de 2 modelos" });
  }
  try {
    const actor = actorFrom(req);
    const results = await svc.compareModels(r.tenantId, req.params.id, {
      message, models: b.models, user: actor.email, isAdmin: actor.isAdmin,
    });
    return reply.send({ success: true, results });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /no encontrado/.test(msg) ? 404
      : /Solo el creador/.test(msg) ? 403
      : /no permitido|2 modelos|distintos/.test(msg) ? 400 : 500;
    logger.error({ err }, "agents.compare fail");
    return reply.code(code).send({ success: false, error: msg });
  }
}

// ── Publicación (onda 4) ──

export async function postAgentPublish(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const r = req as unknown as Req;
  const actor = actorFrom(req);
  try {
    const agent = await svc.publishAgent(r.tenantId, req.params.id, actor);
    await recordAudit(r.tenantId, "CUSTOM_AGENT_PUBLISHED", {
      agentId: agent.id, name: agent.name, publishedBy: actor.email, asAdmin: actor.isAdmin,
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
  const actor = actorFrom(req);
  try {
    const agent = await svc.unpublishAgent(r.tenantId, req.params.id, actor);
    await recordAudit(r.tenantId, "CUSTOM_AGENT_UNPUBLISHED", {
      agentId: agent.id, name: agent.name, unpublishedBy: actor.email, asAdmin: actor.isAdmin,
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
      model: b.model,
      visibility: b.visibility,
      // Onda 6: el dueño es SIEMPRE el usuario de la sesión
      createdBy: actorFrom(req).email,
    });
    await recordAudit(r.tenantId, "CUSTOM_AGENT_CREATED", {
      agentId: agent.id, name: agent.name, category: agent.category,
      model: agent.model, createdBy: agent.createdBy,
    }).catch(() => null);
    return reply.code(201).send({ success: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /no permitido|secreto/.test(msg) ? 400 : 500;
    logger.error({ err }, "agents.create fail");
    return reply.code(code).send({ success: false, error: msg });
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
      (req.body || {}) as Partial<svc.CreateAgentInput> & { status?: "active" | "archived" },
      actorFrom(req),
    );
    if (!agent) return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    return reply.send({ success: true, agent });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /verificados|Solo el creador/.test(msg) ? 403
      : /no permitido|secreto/.test(msg) ? 400 : 500;
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
    const actor = actorFrom(req);
    const ok = await svc.deleteAgent(r.tenantId, req.params.id, actor);
    if (!ok) return reply.code(404).send({ success: false, error: "Agente no encontrado" });
    await recordAudit(r.tenantId, "CUSTOM_AGENT_DELETED", {
      agentId: req.params.id, deletedBy: actor.email, asAdmin: actor.isAdmin,
    }).catch(() => null);
    return reply.send({ success: true });
  } catch (err) {
    const msg = (err as Error).message;
    const code = /verificados|Solo el creador/.test(msg) ? 403 : 500;
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
    // Onda 6: la identidad del chat es la de la sesión (b.user queda ignorado)
    const { agent, result, conversationId } = await svc.chatWithCustomAgent(r.tenantId, req.params.id, {
      message,
      user: actorFrom(req).email,
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
  // Onda 6: cada uno lista SUS conversaciones (identidad de sesión)
  const userId = actorFrom(req).email;
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
  try {
    const conv = await import("../services/agent-conversations.service");
    // Onda 6: solo se pueden borrar conversaciones propias (sesión)
    const ok = await conv.deleteConversation(r.tenantId, req.params.id, actorFrom(req).email);
    if (!ok) return reply.code(404).send({ success: false, error: "Conversación no encontrada" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "conversations.delete fail");
    return reply.code(500).send({ success: false, error: "Error eliminando conversación" });
  }
}
