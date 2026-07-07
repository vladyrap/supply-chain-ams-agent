import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  listMemory, getMemoryRecord, ingestResolvedTickets,
} from "../services/memory.service";

/** GET /api/memory — lista MemoryRecords del tenant (opcional ?kind=&limit=). */
export async function listMemoryRoute(
  req: FastifyRequest<{ Querystring: { kind?: string; limit?: string } }>,
  reply: FastifyReply
) {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
    const records = await listMemory(req.tenantId, {
      kind: req.query.kind,
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return reply.send({ success: true, records });
  } catch (err) {
    logger.error({ err }, "memory list fail");
    return reply.code(500).send({ success: false, error: "Error listando memoria" });
  }
}

/** GET /api/memory/:id — detalle de un MemoryRecord + su evidencia. */
export async function getMemoryRoute(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const record = await getMemoryRecord(req.tenantId, req.params.id);
    if (!record) return reply.code(404).send({ success: false, error: "MemoryRecord no encontrado" });
    return reply.send({ success: true, record });
  } catch (err) {
    logger.error({ err }, "memory get fail");
    return reply.code(500).send({ success: false, error: "Error leyendo memoria" });
  }
}

/** POST /api/memory/ingest — ingesta idempotente de tickets resueltos → memoria. */
export async function ingestMemoryRoute(req: FastifyRequest, reply: FastifyReply) {
  try {
    const body = (req.body ?? {}) as { daysBack?: number; limit?: number };
    const result = await ingestResolvedTickets(req.tenantId, {
      daysBack: body.daysBack, limit: body.limit,
    });
    return reply.send({ success: true, result });
  } catch (err) {
    logger.error({ err }, "memory ingest fail");
    return reply.code(500).send({ success: false, error: "Error ingiriendo memoria" });
  }
}
