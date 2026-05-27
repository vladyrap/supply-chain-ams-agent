// Triage: clasifica el mensaje del usuario en intención / sistema / urgencia / categoría.
// Usa Gemini con JSON mode + retry/backoff.
import { GoogleGenAI } from "@google/genai";
import { logger } from "../../utils/logger";
import { retryWithBackoff } from "../../utils/retry";
import { extractUsage, recordUsageFireAndForget } from "../usage.service";
import type { TriageResult } from "../../types/support.types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let ai: GoogleGenAI | null = null;
function getAi() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");
  if (!ai) ai = new GoogleGenAI({ apiKey });
  return ai;
}

const SYSTEM_PROMPT = `Eres el motor de triage de una mesa de soporte AMS Supply Chain SAP.
Recibes un texto libre del usuario describiendo un problema. Tu tarea es clasificarlo.

Responde SIEMPRE en JSON puro (sin envoltura markdown) con esta forma EXACTA:

{
  "intent": "consulta_funcional|incidente|solicitud|cambio|pregunta_general",
  "sap_module": "MM|SD|PP|WM|EWM|QM|PM|ARIBA|IBP|BTP|INTEGRACION|NO_INFORMADO",
  "urgency": "baja|media|alta|critica",
  "category": "string corto, ej: 'pricing', 'entrega', 'liberación OC', 'MRP', 'roles', ...",
  "title": "Una línea descriptiva (máx 80 chars)",
  "summary": "2-3 frases describiendo el problema con tus palabras",
  "missing_data": ["dato 1 que falta", "dato 2 que falta"],
  "confidence": "baja|media|alta",
  "needs_escalation": true|false,
  "escalation_reason": "explicación breve si needs_escalation=true"
}

Criterios de urgencia:
- critica: operación productiva detenida, facturación bloqueada, ningún workaround
- alta: grupo de usuarios afectado, proceso importante con workaround parcial
- media: caso puntual con workaround
- baja: consulta, mejora, duda funcional

Criterios para escalación (needs_escalation=true):
- El usuario pide cambios reales en sistemas productivos
- Información insuficiente para diagnosticar sin acceso a SAP
- Problema fuera del alcance de Nivel 1 (configuración compleja, ABAP, performance)
- Tema legal, compliance o autorización
- Caso ya escalado antes (te lo indicarán en el contexto)

Si necesitas más datos para confianza media/alta, pídelos en missing_data pero NO escales todavía.`;

export async function triageMessage(userMessage: string, extraContext?: string): Promise<TriageResult> {
  const client = getAi();
  const userContent = extraContext
    ? `Contexto previo:\n${extraContext}\n\nMensaje actual del usuario:\n${userMessage}`
    : `Mensaje del usuario:\n${userMessage}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp: any = await retryWithBackoff(
    () => client.models.generateContent({
      model: MODEL,
      contents: userContent,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: 1024,
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
    { label: "gemini.triage", retries: 2 }
  );

  const usage = extractUsage(resp);
  recordUsageFireAndForget({
    source: "triage",
    model: MODEL,
    promptTokens:     usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens:      usage.totalTokens,
  });

  const text = (resp.text ?? "").trim();
  if (!text) throw new Error("Triage devolvió respuesta vacía");
  let parsed: TriageResult;
  try {
    parsed = JSON.parse(text) as TriageResult;
  } catch {
    // Rescate: tomar entre { y }
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a >= 0 && b > a) {
      parsed = JSON.parse(text.slice(a, b + 1)) as TriageResult;
    } else {
      logger.error({ text }, "triage: JSON inválido");
      throw new Error("Triage devolvió JSON inválido");
    }
  }

  // Saneamos defaults por si el modelo omite campos
  return {
    intent: parsed.intent || "pregunta_general",
    sap_module: parsed.sap_module || "NO_INFORMADO",
    urgency: parsed.urgency || "media",
    category: parsed.category || "general",
    title: (parsed.title || userMessage.slice(0, 80)).slice(0, 200),
    summary: parsed.summary || userMessage.slice(0, 280),
    missing_data: Array.isArray(parsed.missing_data) ? parsed.missing_data : [],
    confidence: parsed.confidence || "media",
    needs_escalation: !!parsed.needs_escalation,
    escalation_reason: parsed.escalation_reason,
  };
}

// SLA por urgencia (minutos)
export function slaMinutesForUrgency(u: TriageResult["urgency"]): number {
  switch (u) {
    case "critica": return 60;
    case "alta":    return 240;     // 4h
    case "media":   return 480;     // 8h
    case "baja":    return 1440;    // 24h
  }
}

// Rol de N2 sugerido por módulo
export function suggestedAssigneeRole(sapModule: string): string {
  const m = sapModule.toUpperCase();
  const known = ["MM","SD","PP","WM","EWM","QM","PM","ARIBA","IBP","BTP","INTEGRACION"];
  if (known.includes(m)) return `N2_${m}`;
  return "N2_AMS";
}
