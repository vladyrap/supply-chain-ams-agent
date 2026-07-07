import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  getKnowledgeGraph, getPersistedKnowledgeGraph, rebuildKnowledgeGraph,
} from "../services/graph.service";

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

/** GET /api/graph/persisted — lee el grafo materializado (kg_node/kg_edge). */
export async function getPersistedGraphRoute(
  req: FastifyRequest<{ Querystring: { limit?: string } }>,
  reply: FastifyReply
) {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 500;
    const g = await getPersistedKnowledgeGraph(req.tenantId, { limit: Number.isFinite(limit) ? limit : 500 });
    return reply.send({ success: true, graph: g, persisted: true });
  } catch (err) {
    logger.error({ err }, "graph persisted fail");
    return reply.code(500).send({ success: false, error: "Error leyendo grafo persistido" });
  }
}

/** POST /api/graph/rebuild — materializa la proyección del tenant (idempotente). */
export async function rebuildGraphRoute(req: FastifyRequest, reply: FastifyReply) {
  try {
    const result = await rebuildKnowledgeGraph(req.tenantId);
    return reply.send({ success: true, result });
  } catch (err) {
    logger.error({ err }, "graph rebuild fail");
    return reply.code(500).send({ success: false, error: "Error reconstruyendo grafo" });
  }
}
