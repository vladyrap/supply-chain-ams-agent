import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  listMemory, getMemoryRecord, ingestResolvedTickets,
  retrieveMemory, recordDecision, exportMemory, memoryStats,
} from "../services/memory.service";
import {
  ingestCleanCoreFindings, type IngestCleanCoreInput,
} from "../services/clean-core-ingest.service";

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

/** POST /api/memory/ingest/clean-core — ingiere hallazgos del connector Clean Core. */
export async function ingestCleanCoreRoute(req: FastifyRequest, reply: FastifyReply) {
  try {
    const body = (req.body ?? {}) as IngestCleanCoreInput;
    if (!Array.isArray(body.findings)) {
      return reply.code(400).send({ success: false, error: "Se requiere findings[]" });
    }
    const result = await ingestCleanCoreFindings(req.tenantId, body);
    return reply.send({ success: true, result });
  } catch (err) {
    logger.error({ err }, "memory ingest clean-core fail");
    return reply.code(500).send({ success: false, error: "Error ingiriendo hallazgos Clean Core" });
  }
}

/** GET /api/memory/search?q= — recuperación híbrida (memoria + grafo). Fase 3. */
export async function searchMemoryRoute(
  req: FastifyRequest<{ Querystring: { q?: string; limit?: string } }>,
  reply: FastifyReply
) {
  try {
    const q = (req.query.q ?? "").toString();
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const result = await retrieveMemory(req.tenantId, q, {
      limit: Number.isFinite(limit as number) ? limit : undefined,
    });
    return reply.send({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "memory search fail");
    return reply.code(500).send({ success: false, error: "Error buscando en memoria" });
  }
}

/** POST /api/memory/decision — registra una decisión (IA propone, consultor decide). Fase 4. */
export async function recordDecisionRoute(req: FastifyRequest, reply: FastifyReply) {
  try {
    const body = (req.body ?? {}) as {
      title?: string; context?: string; alternatives?: string[];
      chosen?: string; rationale?: string; reversible?: boolean;
      nodeRefs?: string[]; createdBy?: string;
    };
    if (!body.title || !body.title.trim()) {
      return reply.code(400).send({ success: false, error: "Se requiere title" });
    }
    const result = await recordDecision({
      tenantId: req.tenantId,
      title: body.title,
      context: body.context,
      alternatives: body.alternatives,
      chosen: body.chosen,
      rationale: body.rationale,
      reversible: body.reversible,
      nodeRefs: body.nodeRefs,
      createdBy: body.createdBy,
    });
    return reply.send({ success: true, result });
  } catch (err) {
    logger.error({ err }, "memory decision fail");
    return reply.code(500).send({ success: false, error: "Error registrando decisión" });
  }
}

/** GET /api/memory/export — exporta memoria + grafo del tenant (portabilidad, IA reemplazable). Fase 4. */
export async function exportMemoryRoute(req: FastifyRequest, reply: FastifyReply) {
  try {
    const dump = await exportMemory(req.tenantId);
    return reply.send({ success: true, export: dump });
  } catch (err) {
    logger.error({ err }, "memory export fail");
    return reply.code(500).send({ success: false, error: "Error exportando memoria" });
  }
}

/** GET /api/memory/stats — métricas de la memoria del tenant (cobertura, calidad). Fase 4. */
export async function statsMemoryRoute(req: FastifyRequest, reply: FastifyReply) {
  try {
    const stats = await memoryStats(req.tenantId);
    return reply.send({ success: true, stats });
  } catch (err) {
    logger.error({ err }, "memory stats fail");
    return reply.code(500).send({ success: false, error: "Error calculando métricas de memoria" });
  }
}
