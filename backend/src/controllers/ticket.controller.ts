import type { FastifyRequest, FastifyReply } from "fastify";
import {
  listTickets, getTicketByKey, getTicketProviderStatus,
  createUserTicket, recalculateUserTicket, applyManualEstimatePatch,
  closeTicketWithActualHours,
  type CreateTicketInput, type ManualEstimatePatch, type CloseTicketInput,
} from "../services/ticket.service";
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

export async function getTickets(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const { source, tickets } = await listTickets();
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
    const ticket = await getTicketByKey(req.params.key);
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
    const ticket = await createUserTicket(body);
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
    const ticket = await recalculateUserTicket(req.params.key, { force, actor });
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
    const ticket = await applyManualEstimatePatch(req.params.key, patch, actor, reason);
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
    const ticket = await getTicketByKey(req.params.key);
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
    const ticket = await closeTicketWithActualHours(req.params.key, {
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
