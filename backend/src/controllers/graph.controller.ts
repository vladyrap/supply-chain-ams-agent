import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import { getKnowledgeGraph } from "../services/graph.service";

export async function getGraphRoute(
  req: FastifyRequest<{ Querystring: { limit?: string } }>,
  reply: FastifyReply
) {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 30;
    const g = await getKnowledgeGraph(req.tenantId, { limitPerType: Number.isFinite(limit) ? limit : 30 });
    return reply.send({ success: true, graph: g });
  } catch (err) {
    logger.error({ err }, "graph fail");
    return reply.code(500).send({ success: false, error: "Error construyendo grafo" });
  }
}
