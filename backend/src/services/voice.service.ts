// Canal Telefonico IA — servicio core.
//
// Responsabilidades:
//   1) Hablar con el LLM (Gemini) en modo voz, usando voice-system-prompt.md
//      y limitando longitud de respuesta para que sea leible por TTS.
//   2) Construir TwiML para Twilio (saludo, gather, respuesta, despedida).
//   3) Mantener una pequeña memoria de turnos por callSid en memoria del proceso
//      para dar continuidad a la conversación dentro de una misma llamada.
//   4) Validar firma X-Twilio-Signature de manera opcional.
//
// PROVIDER-AGNOSTIC: La estructura está pensada para que más adelante se pueda
// agregar Vonage, Telnyx, SIP o Asterisk implementando la misma interfaz
// VoiceProvider. Hoy solo Twilio está implementado.

import { GoogleGenAI } from "@google/genai";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { logger } from "../utils/logger";
import { retryWithBackoff } from "../utils/retry";
import { recordUsageFireAndForget, extractUsage } from "./usage.service";

// =========================================================
// Config
// =========================================================
export const VOICE_DEFAULT_LANGUAGE = process.env.VOICE_DEFAULT_LANGUAGE || "es-CL";
export const VOICE_DEFAULT_VOICE    = process.env.VOICE_DEFAULT_VOICE    || "alice";
// Usamos por defecto el modelo lite (mas rpd en free tier + mas barato + mas rapido,
// suficiente para respuestas breves de voz).
const VOICE_MODEL                    = process.env.GEMINI_VOICE_MODEL    || "gemini-2.5-flash-lite";
const VOICE_MAX_OUTPUT_TOKENS        = Number(process.env.VOICE_MAX_OUTPUT_TOKENS || 220);
const VOICE_PROMPT_PATH              = path.resolve(process.cwd(), "prompts", "voice-system-prompt.md");

// =========================================================
// LLM
// =========================================================
let cachedClient: GoogleGenAI | null = null;
let cachedPrompt: string | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no esta configurada");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

async function loadVoicePrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;
  try {
    cachedPrompt = await readFile(VOICE_PROMPT_PATH, "utf-8");
    return cachedPrompt;
  } catch (err) {
    logger.error({ err, VOICE_PROMPT_PATH }, "voice prompt no se pudo leer; uso fallback inline");
    cachedPrompt = FALLBACK_VOICE_PROMPT;
    return cachedPrompt;
  }
}

const FALLBACK_VOICE_PROMPT = `Eres un asistente de IA que atiende llamadas telefonicas.
Responde en español, frases cortas, sin markdown ni listas. Confirma lo entendido,
pide un dato faltante a la vez y entrega proximos pasos simples. No afirmes haber
ejecutado acciones reales. Si el caso requiere humano, indica derivacion.`;

// =========================================================
// Memoria conversacional por callSid (in-memory)
// =========================================================
interface CallMemoryTurn { role: "user" | "model"; text: string }
const CALL_MEMORY = new Map<string, CallMemoryTurn[]>();
const CALL_MEMORY_MAX_TURNS = 12; // recortamos para no inflar el prompt

function pushTurn(callSid: string, turn: CallMemoryTurn) {
  const arr = CALL_MEMORY.get(callSid) ?? [];
  arr.push(turn);
  if (arr.length > CALL_MEMORY_MAX_TURNS) arr.splice(0, arr.length - CALL_MEMORY_MAX_TURNS);
  CALL_MEMORY.set(callSid, arr);
}

export function clearCallMemory(callSid: string) {
  CALL_MEMORY.delete(callSid);
}

// =========================================================
// Helpers TTS-friendly
// =========================================================

/** Limpia markdown, recorta y normaliza la respuesta para que Twilio Say no lea símbolos. */
export function makeSpeakable(text: string, maxChars = 480): string {
  let t = (text ?? "").trim();
  if (!t) return "Lo siento, no pude generar una respuesta.";
  t = t.replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  t = t.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, "");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  t = t.replace(/\*([^*\n]+)\*/g, "$1");
  t = t.replace(/__([^_\n]+)__/g, "$1");
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/^[ \t]*[-*•●▪]\s+/gm, "");
  t = t.replace(/\|/g, " ");
  t = t.replace(/[*_`~#]+/g, "");
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu, "");
  t = t.replace(/\n{2,}/g, ". ");
  t = t.replace(/\n/g, ", ");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > maxChars) t = t.slice(0, maxChars - 1).replace(/\s+\S*$/, "") + "…";
  return t;
}

/** Escapa contenido para insertar dentro de TwiML/XML. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// =========================================================
// Provider interface (preparado para Vonage/Telnyx/SIP)
// =========================================================
export interface VoiceProvider {
  name: string;
  buildIncomingTwiML(opts?: BuildIncomingOpts): string;
  buildResponseTwiML(opts: BuildResponseOpts): string;
  buildGoodbyeTwiML(): string;
  verifyWebhookSignature?(req: VoiceVerifyReq): boolean;
}

export interface BuildIncomingOpts {
  language?: string;
  voice?: string;
  greeting?: string;
  actionUrl?: string; // default /api/voice/process-speech
}
export interface BuildResponseOpts {
  language?: string;
  voice?: string;
  responseText: string;
  followUpPrompt?: string;
  actionUrl?: string;
}
export interface VoiceVerifyReq {
  signatureHeader: string | null;
  fullUrl: string;            // URL absoluta del webhook
  formParams: Record<string, string | string[] | undefined>;
}

// =========================================================
// Twilio provider
// =========================================================
const DEFAULT_GREETING =
  "Hola, soy el asistente de inteligencia artificial de soporte. Por favor, describe brevemente tu consulta o incidente despues del tono.";
const DEFAULT_FOLLOWUP = "¿Necesitas agregar algo mas?";
const NO_INPUT_RETRY   = "No recibi una respuesta. Puedes intentarlo nuevamente mas tarde. Adios.";
const GOODBYE          = "Gracias por llamar. Hasta luego.";

export const TwilioVoiceProvider: VoiceProvider = {
  name: "twilio",

  buildIncomingTwiML(opts: BuildIncomingOpts = {}): string {
    const language  = opts.language  ?? VOICE_DEFAULT_LANGUAGE;
    const voice     = opts.voice     ?? VOICE_DEFAULT_VOICE;
    const greeting  = opts.greeting  ?? DEFAULT_GREETING;
    const action    = opts.actionUrl ?? "/api/voice/process-speech";
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<Response>`,
      `  <Gather input="speech" language="${escapeXml(language)}" action="${escapeXml(action)}" method="POST" timeout="5" speechTimeout="auto">`,
      `    <Say language="${escapeXml(language)}" voice="${escapeXml(voice)}">${escapeXml(greeting)}</Say>`,
      `  </Gather>`,
      `  <Say language="${escapeXml(language)}" voice="${escapeXml(voice)}">${escapeXml(NO_INPUT_RETRY)}</Say>`,
      `</Response>`,
    ].join("\n");
  },

  buildResponseTwiML(opts: BuildResponseOpts): string {
    const language   = opts.language     ?? VOICE_DEFAULT_LANGUAGE;
    const voice      = opts.voice        ?? VOICE_DEFAULT_VOICE;
    const action     = opts.actionUrl    ?? "/api/voice/process-speech";
    const followUp   = opts.followUpPrompt ?? DEFAULT_FOLLOWUP;
    const reply      = opts.responseText;
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<Response>`,
      `  <Say language="${escapeXml(language)}" voice="${escapeXml(voice)}">${escapeXml(reply)}</Say>`,
      `  <Gather input="speech" language="${escapeXml(language)}" action="${escapeXml(action)}" method="POST" timeout="5" speechTimeout="auto">`,
      `    <Say language="${escapeXml(language)}" voice="${escapeXml(voice)}">${escapeXml(followUp)}</Say>`,
      `  </Gather>`,
      `  <Say language="${escapeXml(language)}" voice="${escapeXml(voice)}">${escapeXml(GOODBYE)}</Say>`,
      `</Response>`,
    ].join("\n");
  },

  buildGoodbyeTwiML(): string {
    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<Response>`,
      `  <Say language="${escapeXml(VOICE_DEFAULT_LANGUAGE)}" voice="${escapeXml(VOICE_DEFAULT_VOICE)}">${escapeXml(GOODBYE)}</Say>`,
      `</Response>`,
    ].join("\n");
  },

  /**
   * Verificacion X-Twilio-Signature.
   * https://www.twilio.com/docs/usage/security#validating-requests
   *
   * Algoritmo: HMAC-SHA1(authToken, fullUrl + sortedParamsConcat) en Base64.
   * Retorna false si no hay TWILIO_AUTH_TOKEN configurado (modo abierto en dev).
   */
  verifyWebhookSignature(req: VoiceVerifyReq): boolean {
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!token) return false; // no podemos validar, decision arriba en el caller
    if (!req.signatureHeader) return false;
    const sortedKeys = Object.keys(req.formParams).sort();
    let payload = req.fullUrl;
    for (const k of sortedKeys) {
      const v = req.formParams[k];
      if (Array.isArray(v)) payload += k + v.join("");
      else if (typeof v === "string") payload += k + v;
    }
    const computed = crypto.createHmac("sha1", token).update(payload).digest("base64");
    try {
      return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(req.signatureHeader));
    } catch {
      return false;
    }
  },
};

// =========================================================
// Public API: enviar mensaje del usuario al agente
// =========================================================
export interface VoiceAgentContext {
  /** Datos de la llamada (para contexto/identificación). */
  callSid: string;
  fromNumber?: string | null;
  /** Texto libre que el caller suma como contexto (p.ej. "modo soporte"). */
  hint?: string | null;
}

export interface VoiceAgentResult {
  text: string;             // ya pasado por makeSpeakable
  model: string;
  rawText: string;          // texto crudo del modelo (para auditoria)
  usage: ReturnType<typeof extractUsage>;
}

export async function sendVoiceMessageToAgent(params: {
  message: string;
  context: VoiceAgentContext;
}): Promise<VoiceAgentResult> {
  const userText = (params.message ?? "").trim();
  if (!userText) {
    const fallback = "No te escuche bien. ¿Puedes repetir tu consulta?";
    return { text: fallback, model: VOICE_MODEL, rawText: fallback, usage: extractUsage(undefined) };
  }

  const systemPrompt = await loadVoicePrompt();
  const history = CALL_MEMORY.get(params.context.callSid) ?? [];

  // Construimos un mensaje "contents" simple. Para no complicar con multi-turn
  // formal de Gemini, concatenamos el historial breve en texto, suficiente
  // para conversaciones de 3-6 turnos típicas de un soporte telefónico.
  const transcriptText = history.map((t) => (t.role === "user" ? `Usuario: ${t.text}` : `Asistente: ${t.text}`)).join("\n");
  const headerLines = [
    "[CANAL] Telefono",
    `[CALL_SID] ${params.context.callSid}`,
  ];
  if (params.context.hint) headerLines.push(`[HINT] ${params.context.hint}`);
  headerLines.push("");

  const contents = [
    ...headerLines,
    transcriptText ? `[CONVERSACION PREVIA]\n${transcriptText}\n` : "",
    `[MENSAJE ACTUAL DEL USUARIO]`,
    userText,
    "",
    "Responde en una sola intervencion, frases cortas, lista para ser leida por voz.",
  ].filter(Boolean).join("\n");

  const ai = getClient();
  let rawText = "";
  let modelUsed = VOICE_MODEL;
  try {
    const resp = await retryWithBackoff(
      () => ai.models.generateContent({
        model: VOICE_MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: VOICE_MAX_OUTPUT_TOKENS,
          temperature: 0.4,
        },
      }),
      { retries: 2, initialDelayMs: 600, label: "voice.llm" }
    );
    rawText = (resp.text ?? "").trim();
    modelUsed = VOICE_MODEL;
    const usage = extractUsage(resp);
    recordUsageFireAndForget({
      source: "voice",
      model: modelUsed,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      metadata: { callSid: params.context.callSid },
    });
    // memoria
    pushTurn(params.context.callSid, { role: "user", text: userText });
    pushTurn(params.context.callSid, { role: "model", text: rawText });
    return {
      text: makeSpeakable(rawText),
      model: modelUsed,
      rawText,
      usage,
    };
  } catch (err) {
    logger.error({ err, callSid: params.context.callSid }, "voice agent llm fail");
    const safe = "Tuve un problema al procesar tu consulta. Por favor intenta nuevamente o llama mas tarde.";
    return { text: safe, model: modelUsed, rawText: safe, usage: extractUsage(undefined) };
  }
}
