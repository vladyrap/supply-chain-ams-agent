import type { FastifyRequest, FastifyReply } from "fastify";
import {
  listTickets, getTicketByKey, getTicketProviderStatus,
  createUserTicket, type CreateTicketInput,
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
    const ticket = createUserTicket(body);
    return reply.code(201).send({ success: true, ticket });
  } catch (err) {
    logger.error({ err }, "ticket create fail");
    return reply.code(500).send({ success: false, error: "Error creando ticket" });
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
