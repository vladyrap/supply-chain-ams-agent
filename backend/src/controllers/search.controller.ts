import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import { semanticSearch, reindexAll, getSearchStats, type SearchSourceType } from "../services/search.service";

const VALID_TYPES: ReadonlySet<SearchSourceType> = new Set<SearchSourceType>([
  "incident", "ticket", "conversation", "kb", "meeting", "inbound",
]);

interface SearchQuery {
  q?: string;
  limit?: string;
  types?: string;
}

export async function getSearch(
  req: FastifyRequest<{ Querystring: SearchQuery }>,
  reply: FastifyReply
) {
  const q = (req.query.q ?? "").trim();
  if (!q) return reply.send({ success: true, count: 0, results: [], grouped: {} });

  let types: SearchSourceType[] | undefined;
  if (req.query.types) {
    types = req.query.types.split(",").map((s) => s.trim() as SearchSourceType).filter((t) => VALID_TYPES.has(t));
    if (types.length === 0) types = undefined;
  }
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;

  try {
    const hits = await semanticSearch({ query: q, limit, types });
    const grouped: Record<string, typeof hits> = {};
    for (const h of hits) {
      if (!grouped[h.source_type]) grouped[h.source_type] = [];
      grouped[h.source_type].push(h);
    }
    return reply.send({ success: true, count: hits.length, results: hits, grouped });
  } catch (err) {
    logger.error({ err }, "search fail");
    return reply.code(500).send({ success: false, error: "Error en búsqueda" });
  }
}

export async function postReindex(
  req: FastifyRequest<{ Querystring: { force?: string } }>,
  reply: FastifyReply
) {
  const force = req.query.force === "true";
  try {
    logger.info({ force }, "reindex.start");
    const stats = await reindexAll({ force });
    logger.info({ stats }, "reindex.done");
    return reply.send({ success: true, ...stats });
  } catch (err) {
    logger.error({ err }, "reindex fail");
    return reply.code(500).send({ success: false, error: "Error reindexando" });
  }
}

export async function getSearchStatsRoute(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const stats = await getSearchStats();
    return reply.send({ success: true, ...stats });
  } catch (err) {
    return reply.code(500).send({ success: false, error: "Error" });
  }
}
