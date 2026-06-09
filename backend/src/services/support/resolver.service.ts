// Resolver: dado el mensaje del usuario + triage, intenta responder.
// Estrategia:
//   1. Buscar en KB curada (artículos approved) por ILIKE + filtro de sistema.
//   2. Si hay matches buenos, generar respuesta usando esos artículos como contexto.
//   3. Si no hay, caer a RAG documental (knowledge_items) usando el código existente.
//   4. Si ni la KB ni el RAG aportan, intentar con conocimiento general del modelo.
//   5. Decidir si la respuesta resuelve o requiere escalación.
import { GoogleGenAI } from "@google/genai";
import { logger } from "../../utils/logger";
import { retryWithBackoff } from "../../utils/retry";
import { searchArticles, incUseCount } from "./kb.service";
import { retrieveRelevantChunks } from "../rag.service";
import { extractUsage, recordUsageFireAndForget } from "../usage.service";
import type { TriageResult, KbArticle } from "../../types/support.types";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let ai: GoogleGenAI | null = null;
function getAi() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");
  if (!ai) ai = new GoogleGenAI({ apiKey });
  return ai;
}

const SYSTEM_PROMPT = `Eres "AMS-Bot", la IA de Nivel 1 de la mesa de soporte AMS Supply Chain SAP.

Hablas en español, en un tono cálido y profesional, con frases cortas y claras
(estilo WhatsApp: NO bloques de 12 secciones del consultor senior, ESTO es soporte de primera línea).

Tienes acceso a:
1. KB curada: artículos aprobados por Nivel 2 con formato "problema → solución paso a paso".
2. Contexto RAG: fragmentos de documentación interna (blueprints, manuales).

Tu trabajo es:
- Saludar brevemente la primera vez.
- Pedir SOLO los datos críticos que falten (1-2 a la vez, no una encuesta).
- Si encuentras un artículo de KB que aplique, guiar al usuario por sus pasos UNO A UNO.
- Confirmar al final si funcionó o no.
- Si claramente no puedes resolver o el usuario está bloqueado, **decirle** que vas a escalar a Nivel 2 y por qué.

Reglas:
- No inventes transacciones o caminos del menú.
- Si no estás seguro, dilo y propón escalar.
- No prometas tiempos. La SLA la ve el panel.
- No respondas en formato de 12 bloques. Eso es para el agente experto, no para la mesa.
- Si el usuario es agresivo o pide hablar con humano, escala sin discutir.

Al final de tu respuesta, en una línea separada, devuelve un marcador con tu decisión:

::DECISION:: { "resolved": false, "needs_more_info": true, "should_escalate": false, "kb_article_id": null }

donde:
- resolved=true cuando el usuario explícitamente confirma que el problema quedó solucionado.
- needs_more_info=true cuando aún esperas datos del usuario para avanzar.
- should_escalate=true cuando hay que crear ticket y mandar a Nivel 2.
- kb_article_id: si usaste un artículo de la KB curada, su id; de lo contrario null.

NO incluyas el marcador en la respuesta visible al usuario, sólo al final, en su línea.`;

export interface ResolverContextInput {
  conversationHistory: { role: string; text: string }[];
  triage: TriageResult;
  userClient?: string;
}

export interface ResolverDecision {
  resolved: boolean;
  needs_more_info: boolean;
  should_escalate: boolean;
  kb_article_id: string | null;
}

export interface ResolverResult {
  responseText: string;             // texto limpio para mostrar al usuario
  decision: ResolverDecision;
  kbHits: KbArticle[];              // articles usados como contexto
  ragHits: number;                  // cuántos chunks RAG aportaron
  model: string;
}

function parseDecision(raw: string): { visible: string; decision: ResolverDecision } {
  const marker = "::DECISION::";
  const idx = raw.lastIndexOf(marker);
  let visible = raw;
  let decision: ResolverDecision = {
    resolved: false,
    needs_more_info: false,
    should_escalate: false,
    kb_article_id: null,
  };
  if (idx >= 0) {
    visible = raw.slice(0, idx).trim();
    const tail = raw.slice(idx + marker.length).trim();
    try {
      const parsed = JSON.parse(tail) as Partial<ResolverDecision>;
      decision = {
        resolved: !!parsed.resolved,
        needs_more_info: !!parsed.needs_more_info,
        should_escalate: !!parsed.should_escalate,
        kb_article_id: parsed.kb_article_id ?? null,
      };
    } catch {
      // Si el JSON está mal, lo dejamos en defaults
    }
  }
  return { visible, decision };
}

function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = String((err as any)?.message ?? err);
  return (
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("exceeded your current quota") ||
    msg.includes(" 429") ||
    msg.includes("Too Many Requests")
  );
}

export class QuotaExhaustedError extends Error {
  kind = "quota_exhausted" as const;
  constructor() { super("quota_exhausted"); }
}

export async function resolveWithAi(tenantId: string, input: ResolverContextInput): Promise<ResolverResult> {
  const { triage } = input;
  const lastUserMsg = [...input.conversationHistory].reverse().find((m) => m.role === "user")?.text ?? "";

  // 1. KB curada: buscar por sistema + texto
  let kbHits: KbArticle[] = [];
  try {
    kbHits = await searchArticles(tenantId, { text: lastUserMsg, system: triage.sap_module, limit: 4 });
  } catch (err) {
    logger.warn({ err }, "resolver: kb search fail, sigo sin KB");
  }
  // Marcar uso
  for (const a of kbHits) { incUseCount(tenantId, a.id).catch(() => undefined); }

  // 2. RAG documental — solo si KB no aportó mucho
  let ragHits = 0;
  let ragBlock = "";
  if (kbHits.length === 0) {
    try {
      const chunks = await retrieveRelevantChunks(lastUserMsg, {
        module: triage.sap_module,
        client: input.userClient,
      });
      ragHits = chunks.length;
      if (chunks.length > 0) {
        ragBlock = chunks.map((c, i) =>
          `[RAG ${i + 1} · score ${c.score.toFixed(2)} · ${c.sourceFile} chunk ${c.chunkIndex}]\n${c.content}`
        ).join("\n\n");
      }
    } catch (err) {
      logger.warn({ err }, "resolver: rag retrieve fail");
    }
  }

  // 3. Construir contexto para Gemini
  const kbBlock = kbHits.length > 0
    ? kbHits.map((a, i) => `[KB ${i + 1}] id=${a.id}\nTítulo: ${a.title}\nProblema: ${a.problem}\nSolución:\n${a.solution}`).join("\n\n---\n\n")
    : "";

  const transcript = input.conversationHistory.slice(-12).map((m) => `${m.role === "user" ? "Usuario" : "AMS-Bot"}: ${m.text}`).join("\n");

  const contextParts: string[] = [];
  contextParts.push(`[Triage]\nIntent: ${triage.intent}\nMódulo: ${triage.sap_module}\nUrgencia: ${triage.urgency}\nCategoría: ${triage.category}\nResumen: ${triage.summary}`);
  if (kbBlock)   contextParts.push(`[KB curada]\n${kbBlock}`);
  if (ragBlock)  contextParts.push(`[Documentación interna]\n${ragBlock}`);
  contextParts.push(`[Conversación reciente]\n${transcript}`);
  contextParts.push(`[Mensaje a responder]\n${lastUserMsg}`);

  const userContent = contextParts.join("\n\n");

  const client = getAi();
  let raw = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp: any = await retryWithBackoff(
      () => client.models.generateContent({
        model: MODEL,
        contents: userContent,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: 1500,
          temperature: 0.5,
        },
      }),
      { label: "gemini.resolver", retries: 2 }
    );
    const usage = extractUsage(resp);
    recordUsageFireAndForget({
      source: "resolver",
      model: MODEL,
      promptTokens:     usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens:      usage.totalTokens,
      metadata: { kbHits: kbHits.length, ragHits },
    });
    raw = (resp.text ?? "").trim();
    if (!raw) throw new Error("Resolver devolvió respuesta vacía");
  } catch (err) {
    if (isQuotaError(err)) {
      // Cuota Gemini agotada. Si tenemos KB hits, respondemos con la KB
      // directo (sin Gemini) — la KB ya tiene "problema → solución paso a paso".
      if (kbHits.length > 0) {
        const top = kbHits[0];
        const otros = kbHits.slice(1, 3).map((a) => `• ${a.title}`).join("\n");
        const otrosBlock = otros ? `\n\n_Otros artículos que podrían servir:_\n${otros}` : "";
        const responseText =
          `Encontré un artículo en la base de conocimiento que aplica a tu caso:\n\n` +
          `**${top.title}**\n\n${top.solution}${otrosBlock}\n\n` +
          `¿Te ayudó esta solución? Si no, dímelo y escalo a Nivel 2.`;
        logger.warn({ kbId: top.id }, "resolver: cuota agotada, respondo con KB directo");
        return {
          responseText,
          decision: {
            resolved: false,
            needs_more_info: true,
            should_escalate: false,
            kb_article_id: top.id,
          },
          kbHits,
          ragHits,
          model: `${MODEL}+kb-fallback`,
        };
      }
      // Sin KB → lanzar error tipado para que el orquestador NO escale ticket basura
      throw new QuotaExhaustedError();
    }
    throw err;
  }
  const { visible, decision } = parseDecision(raw);

  // Si el modelo dijo kb_article_id pero no la usamos, descartar
  if (decision.kb_article_id && !kbHits.some((a) => a.id === decision.kb_article_id)) {
    decision.kb_article_id = null;
  }

  return {
    responseText: visible,
    decision,
    kbHits,
    ragHits,
    model: MODEL,
  };
}
