import type { FastifyRequest, FastifyReply } from "fastify";
import { ValidationError, AppError } from "../utils/errors";
import { chatWithAgent, chatWithAgentStream } from "../services/claude.service";
import { researchWithAgent, type ResearchEvent } from "../services/agent-research.service";
import { saveIncident, listIncidents, getIncidentById } from "../services/incident.service";
import { recordAudit, listAudit } from "../services/audit.service";
import { getStats } from "../services/stats.service";
import { emitEventFireAndForget } from "../services/integrations/delivery.service";
import { buildAgentMetadata } from "../utils/agent-meta";
import { logger } from "../utils/logger";
import type { AmsChatRequest, Attachment, AttachmentMime } from "../types/ams.types";

const MAX_MESSAGE_LENGTH = 8000;
const VALID_MODULES = new Set([
  "NO_INFORMADO", "MM", "SD", "PP", "WM", "EWM", "QM", "PM",
  "ARIBA", "IBP", "BTP", "INTEGRACION",
]);
const VALID_ENVIRONMENTS = new Set([
  "NO_INFORMADO", "DEV", "QA", "PRD", "SANDBOX",
]);

// Limites de adjuntos
const ALLOWED_MIME: ReadonlySet<AttachmentMime> = new Set<AttachmentMime>([
  "image/png", "image/jpeg", "image/webp",
]);
const MAX_ATTACHMENTS = 4;
const MAX_BYTES_PER_ATTACHMENT = 5 * 1024 * 1024;  // 5 MB
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;          // 18 MB total payload

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function normalizeAttachments(raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError("attachments debe ser una lista");
  }
  if (raw.length === 0) return [];
  if (raw.length > MAX_ATTACHMENTS) {
    throw new ValidationError(`Máximo ${MAX_ATTACHMENTS} archivos adjuntos por consulta`);
  }

  let total = 0;
  const out: Attachment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (!isPlainObject(a)) {
      throw new ValidationError(`Adjunto #${i + 1} inválido`);
    }
    const name = typeof a.name === "string" ? a.name.slice(0, 200) : `adjunto-${i + 1}`;
    const mimeType = a.mimeType;
    const dataBase64 = a.dataBase64;
    const sizeBytes = a.sizeBytes;

    if (typeof mimeType !== "string" || !ALLOWED_MIME.has(mimeType as AttachmentMime)) {
      throw new ValidationError(
        `Tipo de archivo no permitido en adjunto "${name}". Solo PNG, JPEG y WEBP.`
      );
    }
    if (typeof dataBase64 !== "string" || dataBase64.length === 0) {
      throw new ValidationError(`Adjunto "${name}" sin contenido`);
    }
    // base64 inflado ~33% respecto al binario. Verificamos rapido por longitud de string:
    // base64.length * 0.75 ≈ bytes binarios reales.
    const approxBytes = Math.floor((dataBase64.length * 3) / 4);
    const finalSize = typeof sizeBytes === "number" && sizeBytes > 0 ? sizeBytes : approxBytes;
    if (approxBytes > MAX_BYTES_PER_ATTACHMENT) {
      throw new ValidationError(
        `Adjunto "${name}" supera el máximo de ${MAX_BYTES_PER_ATTACHMENT / (1024 * 1024)} MB`
      );
    }
    total += approxBytes;
    if (total > MAX_TOTAL_BYTES) {
      throw new ValidationError(
        `El conjunto de adjuntos supera el máximo de ${MAX_TOTAL_BYTES / (1024 * 1024)} MB`
      );
    }
    out.push({
      name,
      mimeType: mimeType as AttachmentMime,
      sizeBytes: finalSize,
      dataBase64,
    });
  }
  return out;
}

function normalize(body: AmsChatRequest) {
  if (!body || typeof body !== "object") {
    throw new ValidationError("El cuerpo de la petición es inválido");
  }
  const { message } = body;
  if (typeof message !== "string") {
    throw new ValidationError("El campo message es obligatorio");
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("El campo message es obligatorio");
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`El campo message supera el límite de ${MAX_MESSAGE_LENGTH} caracteres`);
  }

  const rawModule = (body.module ?? "NO_INFORMADO").toString().toUpperCase();
  const module = VALID_MODULES.has(rawModule) ? rawModule : "NO_INFORMADO";

  const rawEnv = (body.environment ?? "NO_INFORMADO").toString().toUpperCase();
  const environment = VALID_ENVIRONMENTS.has(rawEnv) ? rawEnv : "NO_INFORMADO";

  const attachments = normalizeAttachments(body.attachments);

  return {
    message: trimmed,
    user: (body.user ?? "anonymous").toString(),
    module,
    client: (body.client ?? "NO_INFORMADO").toString(),
    environment,
    attachments,
  };
}

export async function postChat(req: FastifyRequest, reply: FastifyReply) {
  let normalized;
  try {
    normalized = normalize(req.body as AmsChatRequest);
  } catch (err) {
    if (err instanceof ValidationError) {
      return reply.code(400).send({ success: false, error: err.publicMessage });
    }
    throw err;
  }

  await recordAudit("CHAT_REQUEST_RECEIVED", {
    user: normalized.user,
    module: normalized.module,
    client: normalized.client,
    environment: normalized.environment,
    messageLength: normalized.message.length,
    attachmentCount: normalized.attachments.length,
  });

  try {
    await recordAudit("CLAUDE_REQUEST_SENT", {
      module: normalized.module,
      environment: normalized.environment,
      attachmentCount: normalized.attachments.length,
    });

    const result = await chatWithAgent({
      userMessage: normalized.message,
      user: normalized.user,
      module: normalized.module,
      client: normalized.client,
      environment: normalized.environment,
      attachments: normalized.attachments,
      tenantId: req.tenantId,
    });

    await recordAudit("CLAUDE_RESPONSE_RECEIVED", {
      model: result.model,
      confidence: result.confidence,
      length: result.text.length,
    });

    const incident = await saveIncident(req.tenantId, {
      input: normalized,
      response: result.text,
      confidence: result.confidence,
      model: result.model,
    });

    await recordAudit("INCIDENT_SAVED", { incidentId: incident.id });

    emitEventFireAndForget("incident.created", {
      incident_id: incident.id,
      user: normalized.user,
      client: normalized.client,
      module: normalized.module,
      environment: normalized.environment,
      message: normalized.message.slice(0, 200),
      model: result.model,
      confidence: result.confidence,
      has_attachments: normalized.attachments.length > 0,
    });

    const metadata = await buildAgentMetadata({
      model: result.model,
      confidence: result.confidence,
      timestamp: incident.created_at,
      responseId: result.responseId,
      ragSources: result.ragSources,
    });
    return reply.send({
      success: true,
      agent: "ams-supply-chain-agent",
      input: {
        message: normalized.message,
        user: normalized.user,
        module: normalized.module,
        client: normalized.client,
        environment: normalized.environment,
        attachmentCount: normalized.attachments.length,
      },
      response: result.text,
      metadata,
    });
  } catch (err) {
    logger.error({ err }, "Fallo en /api/ams/chat");
    await recordAudit("ERROR", {
      where: "postChat",
      message: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ success: false, error: err.publicMessage });
    }
    return reply
      .code(500)
      .send({ success: false, error: "Error procesando la solicitud del agente AMS" });
  }
}

interface IncidentsQuery {
  module?: string;
  client?: string;
  environment?: string;
  fromDate?: string;
  toDate?: string;
  hasAttachments?: string;
  search?: string;
  limit?: string;
}

// ============================================================
// POST /api/ams/chat/stream — Server-Sent Events
// ============================================================
// Eventos emitidos como SSE (data: <json>\n\n):
//   { type: "start",  input: {...} }
//   { type: "delta",  text: "..." }     (varios)
//   { type: "done",   incidentId, metadata }
//   { type: "error",  error }
//
// La persistencia del incidente ocurre AL FINAL (texto completo en memoria).
//
// CORS: cuando hijack()eamos `reply.raw`, perdemos el handler de Fastify que
// normalmente agrega los headers Access-Control-Allow-*. Tenemos que ponerlos
// a mano usando el mismo whitelist que el plugin de CORS.
const STREAM_ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
  "http://localhost:6700,http://localhost:6600,http://127.0.0.1:6700,http://127.0.0.1:6600")
  .split(",").map((s) => s.trim()).filter(Boolean);

// ============================================================
// POST /api/ams/research — Tool-use mode (sin streaming)
// El agente puede invocar tools de SAP/KB/RAG autónomamente y devolver
// la respuesta integrando los datos reales. Incluye log de tool calls.
// ============================================================
export async function postResearch(req: FastifyRequest, reply: FastifyReply) {
  let normalized;
  try {
    normalized = normalize(req.body as AmsChatRequest);
  } catch (err) {
    if (err instanceof ValidationError) {
      return reply.code(400).send({ success: false, error: err.publicMessage });
    }
    throw err;
  }

  await recordAudit("CHAT_REQUEST_RECEIVED", {
    user: normalized.user,
    module: normalized.module,
    client: normalized.client,
    environment: normalized.environment,
    messageLength: normalized.message.length,
    attachmentCount: normalized.attachments.length,
    mode: "research",
  });

  try {
    const result = await researchWithAgent({
      userMessage: normalized.message,
      user: normalized.user,
      module: normalized.module,
      client: normalized.client,
      environment: normalized.environment,
      tenantId: req.tenantId,
      attachments: normalized.attachments,
    });

    await recordAudit("CLAUDE_RESPONSE_RECEIVED", {
      model: result.model,
      confidence: result.confidence,
      length: result.text.length,
      mode: "research",
      iterations: result.iterations,
      toolCalls: result.toolCalls.length,
    });

    const incident = await saveIncident(req.tenantId, {
      input: normalized,
      response: result.text,
      confidence: result.confidence,
      model: result.model + " (research)",
    });
    await recordAudit("INCIDENT_SAVED", { incidentId: incident.id });

    emitEventFireAndForget("incident.created", {
      incident_id: incident.id,
      user: normalized.user,
      client: normalized.client,
      module: normalized.module,
      environment: normalized.environment,
      message: normalized.message.slice(0, 200),
      model: result.model,
      confidence: result.confidence,
      mode: "research",
      tool_calls: result.toolCalls.length,
    });

    return reply.send({
      success: true,
      agent: "ams-supply-chain-agent",
      mode: "research",
      input: {
        message: normalized.message,
        user: normalized.user,
        module: normalized.module,
        client: normalized.client,
        environment: normalized.environment,
        attachmentCount: normalized.attachments.length,
      },
      response: result.text,
      metadata: {
        ...(await buildAgentMetadata({
          model: result.model,
          confidence: result.confidence,
          timestamp: incident.created_at,
        })),
        iterations: result.iterations,
        toolCalls: result.toolCalls.map((tc) => ({
          name: tc.name,
          args: tc.args,
          durationMs: tc.durationMs,
          resultSummary: summarizeToolResult(tc.result),
        })),
      },
    });
  } catch (err) {
    logger.error({ err }, "Fallo en /api/ams/research");
    await recordAudit("ERROR", {
      where: "postResearch",
      message: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ success: false, error: err.publicMessage });
    }
    return reply.code(500).send({ success: false, error: "Error procesando la solicitud del agente AMS" });
  }
}

// POST /api/ams/research/stream — Research con eventos en vivo (SSE)
// Para el visualizador "el agente pensando".
export async function streamResearch(req: FastifyRequest, reply: FastifyReply) {
  let normalized;
  try {
    normalized = normalize(req.body as AmsChatRequest);
  } catch (err) {
    if (err instanceof ValidationError) {
      return reply.code(400).send({ success: false, error: err.publicMessage });
    }
    throw err;
  }

  const origin = (req.headers.origin || "").toString();
  const sseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (origin && STREAM_ALLOWED_ORIGINS.includes(origin)) {
    sseHeaders["Access-Control-Allow-Origin"] = origin;
    sseHeaders["Access-Control-Allow-Credentials"] = "true";
    sseHeaders["Vary"] = "Origin";
  }
  reply.raw.writeHead(200, sseHeaders);
  const send = (obj: unknown) => {
    if (clientClosed) return; // FIX M15: no escribir a socket cerrado
    try {
      reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* socket cerrado entre check y write — ignorar */
    }
  };
  reply.hijack();

  // FIX M15 (audit v1.1.0): detectar cierre del cliente para terminar el loop
  // de research lo antes posible. Antes: cliente cerraba tab → flushPromise
  // seguía corriendo + research seguía gastando Gemini por respuesta que
  // nadie veía. Ahora: clientClosed flag corta el while loop y los sends.
  let clientClosed = false;
  req.raw.once("close", () => {
    clientClosed = true;
  });

  // Cola de eventos. researchWithAgent invocará onEvent y nosotros los drenamos.
  const queue: ResearchEvent[] = [];
  let finished = false;
  // eslint-disable-next-line no-async-promise-executor
  const flushPromise = new Promise<void>(async (resolve) => {
    while (!finished || queue.length > 0) {
      if (clientClosed) break; // M15: salir si cliente desconectó
      while (queue.length > 0) {
        send(queue.shift());
      }
      if (finished) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    resolve();
  });

  try {
    await researchWithAgent({
      userMessage: normalized.message,
      user: normalized.user,
      module: normalized.module,
      client: normalized.client,
      environment: normalized.environment,
      tenantId: req.tenantId,
      attachments: normalized.attachments,
      onEvent: (ev) => {
        if (!clientClosed) queue.push(ev);
      },
    });
  } catch (err) {
    queue.push({
      type: "error",
      message: err instanceof Error ? err.message : "Error desconocido",
    });
  } finally {
    finished = true;
    await flushPromise;
    try { reply.raw.end(); } catch { /* ya cerrado */ }
  }
}

function summarizeToolResult(result: unknown): string {
  if (result === null || result === undefined) return "—";
  if (typeof result !== "object") return String(result).slice(0, 200);
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string") return `error: ${r.error}`;
  if (r.found === false) return `not found`;
  if (typeof r.count === "number") return `${r.count} results`;
  const keys = Object.keys(r).slice(0, 4);
  return keys.map((k) => `${k}=${JSON.stringify(r[k]).slice(0, 30)}`).join(", ");
}

export async function postChatStream(req: FastifyRequest, reply: FastifyReply) {
  let normalized;
  try {
    normalized = normalize(req.body as AmsChatRequest);
  } catch (err) {
    if (err instanceof ValidationError) {
      return reply.code(400).send({ success: false, error: err.publicMessage });
    }
    throw err;
  }

  // Headers CORS para el browser: cuando hacemos hijack, escribimos el response
  // a mano y necesitamos replicar lo que @fastify/cors haría normalmente.
  const origin = (req.headers.origin || "").toString();
  const sseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (origin && STREAM_ALLOWED_ORIGINS.includes(origin)) {
    sseHeaders["Access-Control-Allow-Origin"] = origin;
    sseHeaders["Access-Control-Allow-Credentials"] = "true";
    sseHeaders["Vary"] = "Origin";
  }
  reply.raw.writeHead(200, sseHeaders);
  const send = (obj: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  reply.hijack();

  await recordAudit("CHAT_REQUEST_RECEIVED", {
    user: normalized.user,
    module: normalized.module,
    client: normalized.client,
    environment: normalized.environment,
    messageLength: normalized.message.length,
    attachmentCount: normalized.attachments.length,
    streaming: true,
  });

  send({
    type: "start",
    input: {
      message: normalized.message,
      user: normalized.user,
      module: normalized.module,
      client: normalized.client,
      environment: normalized.environment,
      attachmentCount: normalized.attachments.length,
    },
  });

  try {
    await recordAudit("CLAUDE_REQUEST_SENT", {
      module: normalized.module,
      environment: normalized.environment,
      attachmentCount: normalized.attachments.length,
      streaming: true,
    });

    let fullText = "";
    let model = "";
    let confidence: "baja" | "media" | "alta" | "no_detectada" = "no_detectada";

    for await (const ev of chatWithAgentStream({
      userMessage: normalized.message,
      user: normalized.user,
      module: normalized.module,
      client: normalized.client,
      environment: normalized.environment,
      attachments: normalized.attachments,
      tenantId: req.tenantId,
    })) {
      if (ev.type === "delta") {
        send({ type: "delta", text: ev.text });
      } else if (ev.type === "done") {
        fullText = ev.fullText;
        model = ev.model;
        confidence = ev.confidence;
      }
    }

    await recordAudit("CLAUDE_RESPONSE_RECEIVED", {
      model,
      confidence,
      length: fullText.length,
      streaming: true,
    });

    const incident = await saveIncident(req.tenantId, {
      input: normalized,
      response: fullText,
      confidence,
      model,
    });
    await recordAudit("INCIDENT_SAVED", { incidentId: incident.id });

    emitEventFireAndForget("incident.created", {
      incident_id: incident.id,
      user: normalized.user,
      client: normalized.client,
      module: normalized.module,
      environment: normalized.environment,
      message: normalized.message.slice(0, 200),
      model,
      confidence,
      streaming: true,
      has_attachments: normalized.attachments.length > 0,
    });

    send({
      type: "done",
      incidentId: incident.id,
      metadata: await buildAgentMetadata({
        model, confidence, timestamp: incident.created_at,
      }),
    });
    reply.raw.end();
  } catch (err) {
    logger.error({ err }, "Fallo en /api/ams/chat/stream");
    await recordAudit("ERROR", {
      where: "postChatStream",
      message: err instanceof Error ? err.message : String(err),
    });
    const publicMsg = err instanceof AppError ? err.publicMessage : "Error procesando la solicitud del agente AMS";
    try { send({ type: "error", error: publicMsg }); } catch { /* conn muerta */ }
    reply.raw.end();
  }
}

export async function getIncidents(
  req: FastifyRequest<{ Querystring: IncidentsQuery }>,
  reply: FastifyReply
) {
  try {
    const q = req.query;
    const rows = await listIncidents(req.tenantId, {
      module:         q.module || undefined,
      client:         q.client || undefined,
      environment:    q.environment || undefined,
      fromDate:       q.fromDate || undefined,
      toDate:         q.toDate || undefined,
      hasAttachments: q.hasAttachments === "true" ? true : q.hasAttachments === "false" ? false : undefined,
      search:         q.search || undefined,
      limit:          q.limit ? parseInt(q.limit, 10) : undefined,
    });
    return reply.send({ success: true, count: rows.length, incidents: rows });
  } catch (err) {
    logger.error({ err }, "Fallo listando incidents");
    return reply.code(500).send({ success: false, error: "Error listando incidentes" });
  }
}

export async function getIncident(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return reply.code(400).send({ success: false, error: "ID inválido" });
  }
  try {
    const row = await getIncidentById(req.tenantId, id);
    if (!row) return reply.code(404).send({ success: false, error: "Incidente no encontrado" });
    return reply.send({ success: true, incident: row });
  } catch (err) {
    logger.error({ err }, "Fallo obteniendo incident");
    return reply.code(500).send({ success: false, error: "Error obteniendo incidente" });
  }
}

export async function getAmsStats(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const stats = await getStats();
    return reply.send({ success: true, stats });
  } catch (err) {
    logger.error({ err }, "Fallo calculando stats");
    return reply.code(500).send({ success: false, error: "Error calculando estadísticas" });
  }
}

export async function getAudit(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const rows = await listAudit(100);
    return reply.send({ success: true, count: rows.length, audit: rows });
  } catch (err) {
    logger.error({ err }, "Fallo listando audit");
    return reply.code(500).send({ success: false, error: "Error listando auditoría" });
  }
}
