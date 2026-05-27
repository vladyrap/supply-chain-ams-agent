// =============================================================
// Agente "Research mode": Gemini con function calling
// =============================================================
// Loop ReAct: pedimos a Gemini que responda. Si decide llamar tools
// (SAP read-only, KB search, RAG), las ejecutamos y le devolvemos el
// resultado. Iteramos hasta que Gemini da una respuesta final o
// alcanzamos MAX_ITERATIONS.
//
// Devuelve la respuesta final + el log de tools usadas para auditoría
// y para mostrar al usuario qué hizo el agente.
// =============================================================
import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../utils/logger";
import { retryWithBackoff } from "../utils/retry";
import { ConfigError, ClaudeError } from "../utils/errors";
import { listToolDeclarations, executeTool, type ToolCallLog } from "./tools";
import type { Attachment, ConfidenceLevel } from "../types/ams.types";
import { detectConfidence } from "./claude.service";
import { extractUsage, recordUsageFireAndForget } from "./usage.service";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const MAX_ITERATIONS = 5;
const PROMPT_PATH = path.resolve(process.cwd(), "prompts", "ams-system-prompt.md");

let cachedClient: GoogleGenAI | null = null;
let cachedSystemPrompt: string | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ConfigError("GEMINI_API_KEY no está configurada");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  cachedSystemPrompt = await readFile(PROMPT_PATH, "utf-8");
  return cachedSystemPrompt;
}

const RESEARCH_INSTRUCTIONS = `

# Modo investigación con herramientas — INSTRUCCIONES PRIORITARIAS

⚠️ EN ESTE MODO, **NO DESCRIBAS LAS HERRAMIENTAS, ÚSALAS**.

Tienes acceso a tools reales que consultan datos reales (SAP en modo lectura
y KB interna). Antes de pedir más datos al usuario, INVOCA LAS HERRAMIENTAS
correspondientes para obtener tú mismo la información que falta.

Reglas obligatorias (no opcionales):

1. Si el usuario menciona un CÓDIGO o NOMBRE de material → invoca \`sap_get_material\` AHORA con ese código. NO pidas el centro al usuario antes; la tool devuelve TODAS las vistas por centro.
2. Si menciona un NÚMERO de PO/OC → invoca \`sap_get_purchase_order\` AHORA.
3. Si menciona un NÚMERO de pedido de venta → invoca \`sap_get_sales_order\` AHORA.
4. Si pregunta por movimientos → invoca \`sap_list_stock_movements\` AHORA.
5. Si describe un PROBLEMA → invoca \`kb_search\` AHORA con palabras clave; si nada relevante, intenta \`rag_search\`.
6. Encadena varias tools si una pregunta lo requiere (ej. material + movimientos del mismo material).

NUNCA hagas esto:
- ❌ Describir qué tool USARÍAS sin llamarla
- ❌ Pedir datos al usuario que la tool puede traer sola
- ❌ Decir "ejecutaré X" sin ejecutarlo realmente

Tras usar las tools, integra los datos REALES en los 12 bloques de respuesta
normal. En el bloque 7 referencia los valores concretos que viste
(ej. "según consulté, MAT-5500 tiene stock 12 en centro 1100, último movimiento
601 (salida) el 2026-05-25").

Solo responde sin tools si la pregunta es puramente CONCEPTUAL (ej. "¿qué es MRP?").`;

export interface ResearchInput {
  userMessage: string;
  user: string;
  module: string;
  client: string;
  environment: string;
  attachments?: Attachment[];
  conversationId?: string;
  // Callback opcional para emitir eventos en vivo (usado por SSE visualizer).
  // No bloquea: cualquier error en el callback se ignora.
  onEvent?: (ev: ResearchEvent) => void;
}

export type ResearchEvent =
  | { type: "start"; message: string; model: string }
  | { type: "thinking"; iteration: number }
  | { type: "text"; iteration: number; text: string }
  | { type: "tool_call_started"; iteration: number; name: string; args: Record<string, unknown> }
  | { type: "tool_call_done";    iteration: number; name: string; durationMs: number; resultPreview: string }
  | { type: "done"; text: string; iterations: number; toolCalls: number }
  | { type: "error"; message: string };

export interface ResearchResult {
  text: string;
  model: string;
  confidence: ConfidenceLevel;
  toolCalls: ToolCallLog[];
  iterations: number;
}

function safeEmit(input: ResearchInput, ev: ResearchEvent) {
  if (!input.onEvent) return;
  try { input.onEvent(ev); } catch { /* swallow */ }
}

function previewResult(result: unknown): string {
  try {
    const s = typeof result === "string" ? result : JSON.stringify(result);
    return s.slice(0, 200);
  } catch { return "[no serializable]"; }
}

// Tipos mínimos del SDK
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { result: unknown } } };
interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }

export async function researchWithAgent(input: ResearchInput): Promise<ResearchResult> {
  const ai = getClient();
  const systemPrompt = (await loadSystemPrompt()) + RESEARCH_INSTRUCTIONS;
  const tools = [{ functionDeclarations: listToolDeclarations() }];

  // Construir el primer mensaje del usuario con metadata + adjuntos
  const headerText = [
    `Usuario: ${input.user}`,
    `Cliente: ${input.client}`,
    `Módulo SAP: ${input.module}`,
    `Ambiente: ${input.environment}`,
    "",
    "Mensaje:",
    input.userMessage,
  ].join("\n");

  const firstParts: GeminiPart[] = [{ text: headerText }];
  if (input.attachments && input.attachments.length > 0) {
    firstParts.push({
      text: `\nEl usuario adjuntó ${input.attachments.length} imagen(es). Analízalas como evidencia.`,
    });
    for (const a of input.attachments) {
      firstParts.push({ inlineData: { mimeType: a.mimeType, data: a.dataBase64 } });
    }
  }

  const conversation: GeminiContent[] = [{ role: "user", parts: firstParts }];
  const toolCalls: ToolCallLog[] = [];
  let iteration = 0;
  let finalText = "";

  safeEmit(input, { type: "start", message: input.userMessage, model: MODEL });

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    logger.info(
      { iteration, model: MODEL, module: input.module, toolsSoFar: toolCalls.length },
      "research.iteration"
    );
    safeEmit(input, { type: "thinking", iteration });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp: any = await retryWithBackoff(
      () => ai.models.generateContent({
        model: MODEL,
        contents: conversation,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 4096,
          temperature: 0.3,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: tools as any,
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
          },
        },
      }),
      { label: `gemini.research.iter${iteration}`, retries: 2 }
    );

    const usage = extractUsage(resp);
    recordUsageFireAndForget({
      source: "research",
      model: MODEL,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      metadata: { iteration, module: input.module, client: input.client },
    });

    // Recolectar functionCalls y textos de la respuesta
    const candidate = resp.candidates?.[0];
    const parts: GeminiPart[] = candidate?.content?.parts ?? [];
    const fcs = parts.filter((p: GeminiPart): p is Extract<GeminiPart, { functionCall: unknown }> => "functionCall" in p);
    const txts = parts.filter((p: GeminiPart): p is Extract<GeminiPart, { text: unknown }> => "text" in p);

    // Acumular texto de esta iteración (puede haber texto + functionCalls juntos)
    const iterText = txts.map((t) => t.text).join("\n").trim();
    if (iterText) {
      finalText = (finalText ? finalText + "\n\n" : "") + iterText;
      safeEmit(input, { type: "text", iteration, text: iterText });
    }

    // Si no pidió tools, terminamos
    if (fcs.length === 0) {
      logger.info({ iteration }, "research: no tool calls, done");
      break;
    }

    // Ejecutar todas las tools pedidas en esta iteración (paralelo)
    const modelTurn: GeminiContent = { role: "model", parts: [...txts, ...fcs] };
    conversation.push(modelTurn);

    const toolResponses: GeminiPart[] = [];
    await Promise.all(fcs.map(async (fc) => {
      const args = (fc.functionCall.args ?? {}) as Record<string, unknown>;
      safeEmit(input, { type: "tool_call_started", iteration, name: fc.functionCall.name, args });
      const callStart = Date.now();
      const result = await executeTool(
        fc.functionCall.name,
        args,
        { module: input.module, client: input.client, conversationId: input.conversationId }
      );
      const durationMs = Date.now() - callStart;
      toolCalls.push({
        name: fc.functionCall.name,
        args,
        result,
        durationMs,
      });
      safeEmit(input, {
        type: "tool_call_done",
        iteration,
        name: fc.functionCall.name,
        durationMs,
        resultPreview: previewResult(result),
      });
      toolResponses.push({
        functionResponse: {
          name: fc.functionCall.name,
          response: { result },
        },
      });
    }));

    conversation.push({ role: "user", parts: toolResponses });
  }

  if (!finalText) {
    safeEmit(input, { type: "error", message: "Research mode no produjo texto final" });
    throw new ClaudeError("Research mode no produjo texto final");
  }

  safeEmit(input, { type: "done", text: finalText, iterations: iteration, toolCalls: toolCalls.length });

  return {
    text: finalText,
    model: MODEL,
    confidence: detectConfidence(finalText),
    toolCalls,
    iterations: iteration,
  };
}
