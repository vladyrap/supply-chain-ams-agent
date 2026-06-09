import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  validateToken, processInboundEvent, listInboundEvents, getInboundEventById,
  createToken, listTokens, deleteToken,
  type InboundSource,
} from "../services/sap-inbound.service";
import { getUserBySession } from "../services/auth.service";

const COOKIE = "ams_session";

async function getUserId(req: FastifyRequest): Promise<string | null> {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[COOKIE];
  if (!token) return null;
  const u = await getUserBySession(req.tenantId, token);
  return u?.id ?? null;
}

function extractInboundToken(req: FastifyRequest): string | null {
  // Aceptamos en X-AMS-Inbound-Token o como Bearer
  const direct = req.headers["x-ams-inbound-token"];
  if (typeof direct === "string") return direct;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7);
  }
  return null;
}

interface InboundBody {
  sap_system?: string;
  sap_client?: string;
  severity?: "info" | "warning" | "error" | "critical";
  title?: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

async function genericInboundHandler(
  source: InboundSource,
  req: FastifyRequest<{ Body: InboundBody }>,
  reply: FastifyReply
) {
  const token = extractInboundToken(req);
  const tokVal = await validateToken(token ?? "", source);
  if (!tokVal.ok) {
    return reply.code(401).send({ success: false, error: tokVal.reason });
  }

  // Caso especial multi-tenant: el webhook llega SIN auth de sesión.
  // El tenantId viene del token (cada token está scoped a un tenant en la DB).
  // NO usamos req.tenantId porque tenantPlugin habría caído al DEFAULT_TENANT_ID
  // para requests sin JWT.
  const tenantId = tokVal.tenantId;

  const b = req.body || {};
  if (!b.title || typeof b.title !== "string") {
    return reply.code(400).send({ success: false, error: "title obligatorio" });
  }
  try {
    const result = await processInboundEvent(tenantId, {
      source,
      sap_system: b.sap_system,
      sap_client: b.sap_client,
      severity: b.severity,
      title: b.title,
      summary: b.summary,
      payload: b.payload ?? {},
      tokenHint: token ? token.slice(0, 12) + "…" : undefined,
      fromIp: req.ip,
    });
    return reply.send({
      success: true,
      event_id: result.event.id,
      downstream: result.downstream,
    });
  } catch (err) {
    logger.error({ err, source, tenantId }, "sap-inbound: process fail");
    return reply.code(500).send({ success: false, error: "Error procesando inbound" });
  }
}

// 5 endpoints específicos (Routes los enchufa)
export const postInboundIdoc        = (req: FastifyRequest<{ Body: InboundBody }>, reply: FastifyReply) => genericInboundHandler("idoc", req, reply);
export const postInboundShortDump   = (req: FastifyRequest<{ Body: InboundBody }>, reply: FastifyReply) => genericInboundHandler("short_dump", req, reply);
export const postInboundOssNote     = (req: FastifyRequest<{ Body: InboundBody }>, reply: FastifyReply) => genericInboundHandler("oss_note", req, reply);
export const postInboundJobFailure  = (req: FastifyRequest<{ Body: InboundBody }>, reply: FastifyReply) => genericInboundHandler("job_failure", req, reply);
export const postInboundTransport   = (req: FastifyRequest<{ Body: InboundBody }>, reply: FastifyReply) => genericInboundHandler("transport", req, reply);
export const postInboundGeneric     = (req: FastifyRequest<{ Body: InboundBody }>, reply: FastifyReply) => genericInboundHandler("generic", req, reply);

// === Lectura de eventos (admin) ===
// Aquí SÍ usamos req.tenantId porque son endpoints con sesión normal.
export async function getInboundEvents(
  req: FastifyRequest<{ Querystring: { source?: InboundSource } }>,
  reply: FastifyReply
) {
  try {
    const list = await listInboundEvents(req.tenantId, { source: req.query.source });
    return reply.send({ success: true, count: list.length, events: list });
  } catch (err) {
    logger.error({ err }, "sap-inbound: list fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function getInboundEventDetail(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const ev = await getInboundEventById(req.tenantId, req.params.id);
    if (!ev) return reply.code(404).send({ success: false, error: "no encontrado" });
    return reply.send({ success: true, event: ev });
  } catch (err) {
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

// === Token management (admin) ===
export async function postCreateToken(
  req: FastifyRequest<{ Body: { name?: string; sources?: string[] } }>,
  reply: FastifyReply
) {
  const me = await getUserId(req);
  if (!me) return reply.code(401).send({ success: false, error: "no_session" });
  const name = req.body?.name?.trim();
  if (!name) return reply.code(400).send({ success: false, error: "name obligatorio" });
  try {
    const { token, record } = await createToken(req.tenantId, {
      name,
      sources: req.body?.sources,
      createdBy: me,
    });
    return reply.send({
      success: true,
      token,                 // ← solo se devuelve UNA vez
      record: { ...record, token_hash: undefined },
    });
  } catch (err) {
    logger.error({ err }, "create token fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function getTokens(req: FastifyRequest, reply: FastifyReply) {
  try {
    const list = await listTokens(req.tenantId);
    // No devolver token_hash
    return reply.send({
      success: true,
      count: list.length,
      tokens: list.map((t) => ({ ...t, token_hash: undefined })),
    });
  } catch (err) {
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function delToken(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const ok = await deleteToken(req.tenantId, req.params.id);
    if (!ok) return reply.code(404).send({ success: false, error: "no encontrado" });
    return reply.send({ success: true });
  } catch (err) {
    return reply.code(500).send({ success: false, error: "Error" });
  }
}
