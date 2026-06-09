import type { FastifyRequest, FastifyReply } from "fastify";
import {
  listTickets, getTicketByKey, getTicketProviderStatus,
  createUserTicket, recalculateUserTicket, applyManualEstimatePatch,
  closeTicketWithActualHours, replaceTicketEstimate,
  upsertTicketIntelligence, getTicketIntelligence, listIntelligenceHistory,
  updateTicketGeneral, type UpdateTicketGeneralInput,
  type CreateTicketInput, type ManualEstimatePatch, type CloseTicketInput,
  type TicketIntelligence,
} from "../services/ticket.service";
import type { TicketEstimatedResolution } from "../utils/estimation";
import { chatWithAgent } from "../services/claude.service";
import { logger } from "../utils/logger";

export async function getProviderStatus(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const status = await getTicketProviderStatus();
    return reply.send({ success: true, ...status });
  } catch (err) {
    logger.error({ err }, "tickets status fail");
    return reply.code(500).send({ success: false, error: "Error consultando provider" });
  }
}

export async function getTickets(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { source, tickets } = await listTickets(req.tenantId);
    return reply.send({ success: true, source, count: tickets.length, tickets });
  } catch (err) {
    logger.error({ err }, "tickets list fail");
    return reply.code(500).send({ success: false, error: "Error listando tickets" });
  }
}

export async function getTicket(
  req: FastifyRequest<{ Params: { key: string } }>,
  reply: FastifyReply
) {
  try {
    const ticket = await getTicketByKey(req.tenantId, req.params.key);
    if (!ticket) return reply.code(404).send({ success: false, error: "ticket no encontrado" });
    return reply.send({ success: true, ticket });
  } catch (err) {
    logger.error({ err }, "ticket get fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo ticket" });
  }
}

export async function postCreateTicket(
  req: FastifyRequest<{ Body: CreateTicketInput }>,
  reply: FastifyReply
) {
  try {
    const body = req.body || ({} as CreateTicketInput);
    if (!body.title || !body.title.trim()) {
      return reply.code(400).send({ success: false, error: "title es requerido" });
    }
    if (!body.description || !body.description.trim()) {
      return reply.code(400).send({ success: false, error: "description es requerida" });
    }
    const ticket = await createUserTicket(req.tenantId, body);
    return reply.code(201).send({ success: true, ticket });
  } catch (err) {
    logger.error({ err }, "ticket create fail");
    return reply.code(500).send({ success: false, error: "Error creando ticket" });
  }
}

export async function postRecalculateEstimate(
  req: FastifyRequest<{ Params: { key: string }; Body: { force?: boolean; actor?: string } }>,
  reply: FastifyReply
) {
  try {
    const { force, actor } = req.body || {};
    const ticket = await recalculateUserTicket(req.tenantId, req.params.key, { force, actor });
    if (!ticket) return reply.code(404).send({ success: false, error: "ticket no encontrado (solo se pueden recalcular tickets creados desde la UI)" });
    return reply.send({ success: true, ticket });
  } catch (err) {
    logger.error({ err }, "ticket recalc fail");
    return reply.code(500).send({ success: false, error: "Error recalculando" });
  }
}

interface AdjustBody extends ManualEstimatePatch {
  actor: string;
  reason: string;
}
export async function patchManualEstimate(
  req: FastifyRequest<{ Params: { key: string }; Body: AdjustBody }>,
  reply: FastifyReply
) {
  try {
    const body = req.body || ({} as AdjustBody);
    if (!body.actor) return reply.code(400).send({ success: false, error: "actor es requerido" });
    if (!body.reason || !body.reason.trim()) {
      return reply.code(400).send({ success: false, error: "reason es requerido para auditoría" });
    }
    const { actor, reason, ...patch } = body;
    const ticket = await applyManualEstimatePatch(req.tenantId, req.params.key, patch, actor, reason);
    if (!ticket) return reply.code(404).send({ success: false, error: "ticket no encontrado" });
    return reply.send({ success: true, ticket });
  } catch (err) {
    logger.error({ err }, "ticket manual adjust fail");
    return reply.code(500).send({ success: false, error: "Error ajustando estimación" });
  }
}

export async function postClassifyTicket(
  req: FastifyRequest<{ Params: { key: string } }>,
  reply: FastifyReply
) {
  try {
    const ticket = await getTicketByKey(req.tenantId, req.params.key);
    if (!ticket) return reply.code(404).send({ success: false, error: "ticket no encontrado" });

    const message = `Ticket ${ticket.key}: ${ticket.title}\n\nDescripción del ticket:\n${ticket.description}\n\nEstado: ${ticket.status} · Prioridad: ${ticket.priority} · Reporter: ${ticket.reporter ?? "—"}`;

    const result = await chatWithAgent({
      userMessage: message,
      user: "ticket-classifier",
      module: "NO_INFORMADO",
      client: "NO_INFORMADO",
      environment: "NO_INFORMADO",
      attachments: [],
    });

    return reply.send({
      success: true,
      ticket,
      classification: {
        response: result.text,
        model: result.model,
        confidence: result.confidence,
      },
    });
  } catch (err) {
    logger.error({ err }, "ticket classify fail");
    return reply.code(500).send({ success: false, error: "Error clasificando ticket" });
  }
}

/**
 * Reemplaza la estimación completa de un ticket — usado por el motor contextual
 * cuando el consultor decide "aplicar al ticket" su resultado v2.
 *
 * Diferencia con patchManualEstimate: acá reemplaza TODO el objeto
 * estimated_resolution (phases, assumptions, missingData, appliedRules, etc.).
 * El patch solo modifica campos sueltos.
 */
export async function postReplaceEstimate(
  req: FastifyRequest<{
    Params: { key: string };
    Body: { estimate: TicketEstimatedResolution; actor: string; reason?: string };
  }>,
  reply: FastifyReply,
) {
  try {
    const body = req.body || ({} as { estimate: TicketEstimatedResolution; actor: string });
    if (!body.estimate || typeof body.estimate !== "object") {
      return reply.code(400).send({ success: false, error: "estimate (TicketEstimatedResolution) requerido" });
    }
    if (!body.actor || !body.actor.trim()) {
      return reply.code(400).send({ success: false, error: "actor requerido" });
    }
    // Validación básica del shape antes de persistir
    if (typeof body.estimate.totalMinHours !== "number" || typeof body.estimate.totalMaxHours !== "number") {
      return reply.code(400).send({ success: false, error: "totalMinHours y totalMaxHours requeridos" });
    }
    const ticket = await replaceTicketEstimate(req.tenantId, req.params.key, body.estimate);
    if (!ticket) return reply.code(404).send({ success: false, error: "ticket no encontrado" });
    return reply.send({ success: true, ticket });
  } catch (err) {
    logger.error({ err }, "ticket replace estimate fail");
    return reply.code(500).send({ success: false, error: "Error reemplazando estimación" });
  }
}

/**
 * Cierra un ticket capturando las horas reales. Computa desviación contra la
 * estimación y persiste todo en el jsonb del ticket. Crítico para que el motor
 * pueda aprender — sin estas horas, queda en BOOTSTRAP para siempre.
 */
export async function postCloseTicket(
  req: FastifyRequest<{ Params: { key: string }; Body: CloseTicketInput }>,
  reply: FastifyReply,
) {
  try {
    const body = req.body || ({} as CloseTicketInput);
    const actualHours = Number(body.actualHours);
    if (!Number.isFinite(actualHours) || actualHours < 0) {
      return reply.code(400).send({ success: false, error: "actualHours debe ser un número >= 0" });
    }
    if (!body.closedBy || !body.closedBy.trim()) {
      return reply.code(400).send({ success: false, error: "closedBy requerido" });
    }
    const ticket = await closeTicketWithActualHours(req.tenantId, req.params.key, {
      actualHours,
      closedBy: body.closedBy.trim(),
      closeNote: body.closeNote?.trim() || undefined,
    });
    if (!ticket) return reply.code(404).send({ success: false, error: "ticket no encontrado" });
    return reply.send({ success: true, ticket });
  } catch (err) {
    logger.error({ err }, "ticket close fail");
    return reply.code(500).send({ success: false, error: "Error cerrando ticket" });
  }
}

// =============================================================================
// AIE v0.10 — Auto Intelligence Enrichment endpoints
// =============================================================================

/**
 * PUT /api/tickets/:key/intelligence
 * Body: { intelligence: TicketIntelligence }
 *
 * Persiste el resultado del enrichment pipeline (ejecutado en frontend).
 * Idempotente: si el server ya tiene intelligence con mismo inputHash y
 * status=enriched, devuelve `conflict: true` (cliente debe ignorar).
 */
export async function putTicketIntelligence(
  req: FastifyRequest<{ Params: { key: string }; Body: { intelligence: TicketIntelligence } }>,
  reply: FastifyReply
) {
  try {
    const body = req.body;
    if (!body?.intelligence || !body.intelligence.status) {
      return reply.code(400).send({ success: false, error: "intelligence.status es requerido" });
    }
    const result = await upsertTicketIntelligence(req.tenantId, req.params.key, { intelligence: body.intelligence });
    if (!result.ticket) {
      return reply.code(404).send({ success: false, error: "ticket no encontrado" });
    }
    return reply.send({
      success: true,
      ticket: result.ticket,
      conflict: result.conflict ?? null,
    });
  } catch (err) {
    logger.error({ err }, "putTicketIntelligence fail");
    return reply.code(500).send({ success: false, error: "Error persistiendo intelligence" });
  }
}

/**
 * GET /api/tickets/:key/intelligence
 * Devuelve solo el intelligence del ticket (lighter que GET /tickets/:key).
 */
export async function getTicketIntelligenceHandler(
  req: FastifyRequest<{ Params: { key: string } }>,
  reply: FastifyReply
) {
  try {
    const intel = await getTicketIntelligence(req.tenantId, req.params.key);
    return reply.send({ success: true, intelligence: intel });
  } catch (err) {
    logger.error({ err }, "getTicketIntelligence fail");
    return reply.code(500).send({ success: false, error: "Error leyendo intelligence" });
  }
}

/**
 * GET /api/tickets/:key/intelligence/history
 * Histórico de versiones del intelligence (TCC v0.12). Max 20 versiones.
 */
export async function getTicketIntelligenceHistory(
  req: FastifyRequest<{ Params: { key: string } }>,
  reply: FastifyReply
) {
  try {
    const entries = await listIntelligenceHistory(req.tenantId, req.params.key);
    return reply.send({ success: true, entries });
  } catch (err) {
    logger.error({ err }, "getTicketIntelligenceHistory fail");
    return reply.code(500).send({ success: false, error: "Error leyendo historial" });
  }
}

/**
 * PATCH /api/tickets/:key
 * Edita campos generales del ticket (TCC v0.12). Whitelist en el service.
 * No toca intelligence ni estimated_resolution.
 */
export async function patchTicketGeneral(
  req: FastifyRequest<{ Params: { key: string }; Body: UpdateTicketGeneralInput }>,
  reply: FastifyReply
) {
  try {
    const body = req.body ?? {};
    const ticket = await updateTicketGeneral(req.tenantId, req.params.key, body);
    if (!ticket) {
      return reply.code(404).send({ success: false, error: "ticket no encontrado" });
    }
    return reply.send({ success: true, ticket });
  } catch (err) {
    logger.error({ err }, "patchTicketGeneral fail");
    return reply.code(500).send({ success: false, error: "Error actualizando ticket" });
  }
}
