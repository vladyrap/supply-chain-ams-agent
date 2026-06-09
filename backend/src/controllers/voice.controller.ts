// Canal Telefonico IA — controllers HTTP.
// Endpoints expuestos (ver voice.routes.ts):
//   POST /api/voice/incoming         <- Twilio entrante, responde TwiML
//   POST /api/voice/process-speech   <- Twilio gather con SpeechResult
//   POST /api/voice/status           <- Twilio status callback
//   GET  /api/voice/calls            <- listado para UI/admin
//   GET  /api/voice/calls/:callSid   <- detalle con turnos
//
// Multi-tenant: los webhooks de Twilio no traen tenant en el body. Usamos
// req.tenantId que es seteado por tenantPlugin (resolveTenantId fallback al
// DEFAULT_TENANT_ID). Para mapear nº Twilio → tenant en setups multi-cliente,
// se puede mirar req.headers.host o mapear b.To con una tabla.

import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  appendCallTurn, getCallBySid, listCalls, maskPhone,
  startCallLog, updateCallLog,
} from "../services/call-log.service";
import {
  TwilioVoiceProvider, sendVoiceMessageToAgent, clearCallMemory, makeSpeakable,
} from "../services/voice.service";

// =====================================================
// Tipos esperados desde Twilio (form-urlencoded)
// =====================================================
interface TwilioVoiceBody {
  CallSid?: string;
  From?: string;
  To?: string;
  CallStatus?: string;
  Direction?: string;
  SpeechResult?: string;
  Confidence?: string;
  Digits?: string;
  CallDuration?: string;
  Timestamp?: string;
  // ... resto de campos posibles (no los usamos en MVP)
  [key: string]: string | undefined;
}

function xmlReply(reply: FastifyReply, twiml: string, status = 200) {
  reply.header("Content-Type", "text/xml; charset=utf-8");
  reply.status(status);
  return reply.send(twiml);
}

function safeGet<T extends Record<string, unknown>>(obj: T | undefined | null, key: string): string {
  const v = obj?.[key];
  return typeof v === "string" ? v : "";
}

// =====================================================
// POST /api/voice/incoming
// Twilio llama acá al recibir una llamada al número configurado.
// Respondemos con TwiML que saluda y abre un Gather.
// =====================================================
export async function postIncomingCall(
  req: FastifyRequest<{ Body: TwilioVoiceBody }>,
  reply: FastifyReply
) {
  const b = req.body ?? {};
  const callSid = b.CallSid?.trim();
  if (!callSid) {
    logger.warn({ headers: req.headers }, "voice.incoming: sin CallSid; respondiendo TwiML generico");
    return xmlReply(reply, TwilioVoiceProvider.buildGoodbyeTwiML());
  }

  logger.info(
    { callSid, from: maskPhone(b.From), to: maskPhone(b.To), status: b.CallStatus, tenantId: req.tenantId },
    "voice.incoming"
  );

  // Persistencia (best-effort, no rompe la respuesta TwiML si falla)
  try {
    await startCallLog(req.tenantId, {
      callSid,
      fromNumber: b.From ?? null,
      toNumber:   b.To   ?? null,
      callStatus: b.CallStatus ?? "ringing",
    });
    await appendCallTurn(req.tenantId, callSid, "SYSTEM", "Llamada entrante recibida");
  } catch (err) {
    logger.warn({ err, callSid }, "voice.incoming: persistencia fallo, sigo");
  }

  return xmlReply(reply, TwilioVoiceProvider.buildIncomingTwiML());
}

// =====================================================
// POST /api/voice/process-speech
// Twilio envía aquí lo que reconoció del usuario (SpeechResult).
// Llamamos al agente, devolvemos TwiML con la respuesta + nuevo Gather.
// =====================================================
export async function postProcessSpeech(
  req: FastifyRequest<{ Body: TwilioVoiceBody }>,
  reply: FastifyReply
) {
  const b = req.body ?? {};
  const callSid     = b.CallSid?.trim() ?? "";
  const speech      = (b.SpeechResult ?? "").trim();
  const fromNumber  = b.From ?? null;
  const confidence  = b.Confidence ?? null;

  logger.info(
    { callSid, from: maskPhone(fromNumber), confidence, speechLen: speech.length, tenantId: req.tenantId },
    "voice.process-speech"
  );

  if (!callSid) {
    return xmlReply(reply, TwilioVoiceProvider.buildGoodbyeTwiML());
  }

  // Asegurar que el call_log exista (Twilio puede invocar process-speech
  // sin que incoming haya pasado por nuestro endpoint si el webhook se
  // configuró distinto; lo creamos idempotente para no perder el turn).
  try {
    await startCallLog(req.tenantId, {
      callSid,
      fromNumber: b.From ?? null,
      toNumber:   b.To   ?? null,
      callStatus: "in-progress",
    });
  } catch (err) {
    logger.warn({ err, callSid }, "voice.process-speech: startCallLog idempotente fallo");
  }

  // Si no hay speech (timeout sin habla), nos despedimos.
  if (!speech) {
    try {
      await appendCallTurn(req.tenantId, callSid, "SYSTEM", "Sin entrada del usuario en el turno");
      await updateCallLog(req.tenantId, callSid, { mergeMetadata: { lastNoInputAt: new Date().toISOString() } });
    } catch { /* no bloquear */ }
    return xmlReply(reply, TwilioVoiceProvider.buildGoodbyeTwiML());
  }

  // 1) Llamamos al agente con timeout (TwiML debe responderse en <10s ideal)
  let aiText: string;
  try {
    const r = await sendVoiceMessageToAgent({
      message: speech,
      context: { callSid, fromNumber, hint: process.env.VOICE_AGENT_MODE ?? null },
    });
    aiText = r.text;
  } catch (err) {
    logger.error({ err, callSid }, "voice.process-speech: agent fail");
    aiText = makeSpeakable("Tuve un problema procesando tu consulta. Por favor intenta de nuevo.");
  }

  // 2) Persistencia best-effort
  try {
    await appendCallTurn(req.tenantId, callSid, "USER", speech);
    await appendCallTurn(req.tenantId, callSid, "AI", aiText);
    await updateCallLog(req.tenantId, callSid, {
      appendTranscript: `[USER] ${speech}`,
      appendAiResponse: `[AI] ${aiText}`,
    });
  } catch (err) {
    logger.warn({ err, callSid }, "voice.process-speech: persistencia fallo");
  }

  // 3) Devolvemos TwiML con la respuesta y abrimos nuevo Gather para continuar
  return xmlReply(reply, TwilioVoiceProvider.buildResponseTwiML({ responseText: aiText }));
}

// =====================================================
// POST /api/voice/status
// Status callback de Twilio (ringing, in-progress, completed, busy, failed...)
// =====================================================
export async function postCallStatus(
  req: FastifyRequest<{ Body: TwilioVoiceBody }>,
  reply: FastifyReply
) {
  const b = req.body ?? {};
  const callSid    = b.CallSid?.trim();
  const status     = b.CallStatus?.trim() ?? null;
  const duration   = b.CallDuration ? Math.max(0, parseInt(b.CallDuration, 10) || 0) : null;

  if (!callSid) return reply.code(200).send("ok"); // siempre 200 a Twilio

  logger.info(
    { callSid, status, duration, from: maskPhone(b.From), to: maskPhone(b.To), tenantId: req.tenantId },
    "voice.status"
  );

  try {
    const ended = status === "completed" || status === "busy" || status === "failed" ||
                  status === "no-answer" || status === "canceled";
    await updateCallLog(req.tenantId, callSid, {
      callStatus: status,
      endedAt: ended ? new Date() : undefined,
      durationSeconds: duration ?? undefined,
      mergeMetadata: { lastStatusAt: new Date().toISOString() },
    });
    if (ended) {
      await appendCallTurn(req.tenantId, callSid, "SYSTEM", `Llamada finalizada (status=${status})`);
      clearCallMemory(callSid);
    }
  } catch (err) {
    logger.warn({ err, callSid }, "voice.status: persistencia fallo");
  }

  return reply.code(200).send("ok");
}

// =====================================================
// GET /api/voice/calls
// =====================================================
export async function getCallsList(
  req: FastifyRequest<{ Querystring: { limit?: string } }>,
  reply: FastifyReply
) {
  try {
    const limit = req.query?.limit ? Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50)) : 50;
    const calls = await listCalls(req.tenantId, limit);
    return reply.send({
      success: true,
      count: calls.length,
      calls: calls.map((c) => ({
        ...c,
        from_number: maskPhone(c.from_number),
        to_number: maskPhone(c.to_number),
      })),
    });
  } catch (err) {
    logger.error({ err }, "voice.calls.list fail");
    return reply.code(500).send({ success: false, error: "Error listando llamadas" });
  }
}

// =====================================================
// GET /api/voice/calls/:callSid
// =====================================================
export async function getCallDetail(
  req: FastifyRequest<{ Params: { callSid: string } }>,
  reply: FastifyReply
) {
  try {
    const callSid = req.params.callSid;
    if (!callSid) return reply.code(400).send({ success: false, error: "callSid requerido" });
    const { call, turns } = await getCallBySid(req.tenantId, callSid);
    if (!call) return reply.code(404).send({ success: false, error: "No encontrada" });
    return reply.send({
      success: true,
      call: {
        ...call,
        from_number: maskPhone(call.from_number),
        to_number: maskPhone(call.to_number),
      },
      turns,
    });
  } catch (err) {
    logger.error({ err, callSid: req.params.callSid }, "voice.call.detail fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo detalle" });
  }
}
