import type { FastifyRequest, FastifyReply } from "fastify";
import { listScopeItems, getScopeItemByCode, findScopeItemsForTicket } from "../services/scope-items.service";
import { logger } from "../utils/logger";

// FIX G6 (audit MT v1.2.0): pasar req.tenantId al service para coverage scoped.

export async function getScopeItems(
  req: FastifyRequest<{ Querystring: { module?: string } }>,
  reply: FastifyReply
) {
  try {
    const items = await listScopeItems(req.tenantId, { module: req.query.module as never });
    return reply.send({ success: true, count: items.length, items });
  } catch (err) {
    logger.error({ err }, "scope items list fail");
    return reply.code(500).send({ success: false, error: "Error listando scope items" });
  }
}

export async function getScopeItem(
  req: FastifyRequest<{ Params: { code: string } }>,
  reply: FastifyReply
) {
  try {
    const item = await getScopeItemByCode(req.tenantId, req.params.code);
    if (!item) return reply.code(404).send({ success: false, error: "no encontrado" });
    return reply.send({ success: true, item });
  } catch (err) {
    logger.error({ err }, "scope item get fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo scope item" });
  }
}

export async function postSuggestForTicket(
  req: FastifyRequest<{ Body: { module?: string; title?: string; description?: string } }>,
  reply: FastifyReply
) {
  try {
    const items = await findScopeItemsForTicket(req.tenantId, req.body || {});
    return reply.send({ success: true, items });
  } catch (err) {
    logger.error({ err }, "scope items suggest fail");
    return reply.code(500).send({ success: false, error: "Error sugiriendo scope items" });
  }
}
