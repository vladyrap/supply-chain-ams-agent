import type { FastifyRequest, FastifyReply } from "fastify";
import {
  saveCustomerResponse, listCustomerResponsesByTicket, getCustomerResponse,
  updateCustomerResponseStatus, deleteCustomerResponse,
  type SaveCustomerResponseInput,
} from "../services/customer-response.service";
import { logger } from "../utils/logger";

export async function postSaveResponse(
  req: FastifyRequest<{ Params: { key: string }; Body: SaveCustomerResponseInput }>,
  reply: FastifyReply,
) {
  try {
    const body = req.body || ({} as SaveCustomerResponseInput);
    // Validación mínima
    if (!body.responseId || !body.responseType || !body.subject || !body.body) {
      return reply.code(400).send({ success: false, error: "responseId, responseType, subject, body requeridos" });
    }
    // Forzar ticketKey del path
    const row = await saveCustomerResponse(req.tenantId, { ...body, ticketKey: req.params.key });
    return reply.send({ success: true, response: row });
  } catch (err) {
    logger.error({ err }, "save customer response fail");
    return reply.code(500).send({ success: false, error: "Error guardando respuesta" });
  }
}

export async function getListByTicket(
  req: FastifyRequest<{ Params: { key: string } }>,
  reply: FastifyReply,
) {
  try {
    const rows = await listCustomerResponsesByTicket(req.tenantId, req.params.key);
    return reply.send({ success: true, count: rows.length, responses: rows });
  } catch (err) {
    logger.error({ err }, "list responses fail");
    return reply.code(500).send({ success: false, error: "Error listando" });
  }
}

export async function getOne(
  req: FastifyRequest<{ Params: { responseId: string } }>,
  reply: FastifyReply,
) {
  try {
    const row = await getCustomerResponse(req.tenantId, req.params.responseId);
    if (!row) return reply.code(404).send({ success: false, error: "not found" });
    return reply.send({ success: true, response: row });
  } catch (err) {
    logger.error({ err }, "get response fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function patchStatus(
  req: FastifyRequest<{ Params: { responseId: string }; Body: { status: string } }>,
  reply: FastifyReply,
) {
  try {
    const status = req.body?.status;
    if (!status) return reply.code(400).send({ success: false, error: "status requerido" });
    const row = await updateCustomerResponseStatus(req.tenantId, req.params.responseId, status);
    if (!row) return reply.code(404).send({ success: false, error: "not found" });
    return reply.send({ success: true, response: row });
  } catch (err) {
    logger.error({ err }, "patch status fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function deleteOne(
  req: FastifyRequest<{ Params: { responseId: string } }>,
  reply: FastifyReply,
) {
  try {
    const ok = await deleteCustomerResponse(req.tenantId, req.params.responseId);
    if (!ok) return reply.code(404).send({ success: false, error: "not found" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "delete fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}
