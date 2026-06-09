// Servicio del agente LLM.
// NOTA: el archivo se llama claude.service.ts por compatibilidad histórica
// del proyecto, pero internamente usa Google Gemini (tier free).
import { GoogleGenAI } from "@google/genai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ClaudeError, ConfigError } from "../utils/errors";
import { logger } from "../utils/logger";
import { retryWithBackoff } from "../utils/retry";
import { assertCanCallGemini } from "../utils/gemini-rate-limiter";
import { retrieveRelevantChunks, formatContextBlock } from "./rag.service";
import { extractUsage, recordUsageFireAndForget } from "./usage.service";
import type { Attachment, ConfidenceLevel } from "../types/ams.types";

const DEFAULT_MODEL = "gemini-2.5-flash";
const PROMPT_PATH = path.resolve(process.cwd(), "prompts", "ams-system-prompt.md");

let cachedSystemPrompt: string | null = null;
let cachedClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new ConfigError("GEMINI_API_KEY no está configurada");
  }
  if (!cachedClient) {
    cachedClient = new GoogleGenAI({ apiKey });
  }
  return cachedClient;
}

// Cache del prompt activo de DB (TTL 60s para no pegarle a Postgres en cada
// request, pero reaccionar rápido a un "Adoptar" del Playground).
let cachedActivePrompt: { text: string; label: string; expiresAt: number } | null = null;
const ACTIVE_PROMPT_TTL_MS = 60_000;

async function getActiveOverride(): Promise<{ text: string; label: string } | null> {
  if (cachedActivePrompt && cachedActivePrompt.expiresAt > Date.now()) {
    return { text: cachedActivePrompt.text, label: cachedActivePrompt.label };
  }
  try {
    // Import dinámico para evitar ciclo (agent-lab también importa cosas del agente).
    const { getActivePrompt } = await import("./agent-lab.service");
    const row = await getActivePrompt();
    if (row && row.system_prompt) {
      cachedActivePrompt = {
        text: row.system_prompt,
        label: row.label,
        expiresAt: Date.now() + ACTIVE_PROMPT_TTL_MS,
      };
      return { text: row.system_prompt, label: row.label };
    }
    cachedActivePrompt = { text: "", label: "", expiresAt: Date.now() + ACTIVE_PROMPT_TTL_MS };
    return null;
  } catch (err) {
    // Si la tabla no existe todavía (primer arranque sin Playground usado),
    // simplemente no hay override.
    logger.debug({ err }, "agent_prompt_versions no disponible — fallback a archivo");
    return null;
  }
}

/** Permite invalidar el cache desde otros lugares (p.ej. tras adoptar). */
export function invalidateActivePromptCache(): void {
  cachedActivePrompt = null;
}

async function loadSystemPrompt(): Promise<string> {
  // 1) Si hay un prompt adoptado activo en DB, ese gana.
  const override = await getActiveOverride();
  if (override) {
    logger.info({ active: override.label }, "agente usa prompt adoptado del Playground");
    return override.text;
  }
  // 2) Fallback al prompt del archivo (cache eterno tras el primer load).
  if (cachedSystemPrompt) return cachedSystemPrompt;
  try {
    cachedSystemPrompt = await readFile(PROMPT_PATH, "utf-8");
    return cachedSystemPrompt;
  } catch (err) {
    logger.error({ err, PROMPT_PATH }, "No se pudo leer ams-system-prompt.md");
    throw new ConfigError("No se pudo cargar el prompt del agente AMS");
  }
}

export function detectConfidence(responseText: string): ConfidenceLevel {
  const txt = responseText.toLowerCase();
  const block = txt.match(/nivel de confianza[\s\S]{0,200}/);
  const target = block ? block[0] : txt;
  if (/\balta\b/.test(target)) return "alta";
  if (/\bmedia\b/.test(target)) return "media";
  if (/\bbaja\b/.test(target)) return "baja";
  return "no_detectada";
}

export interface RagSourceUsed {
  documentId: string;
  sourceFile: string;
  chunkIndex: number;
  score: number;
}

export interface ClaudeChatResult {
  text: string;
  model: string;
  confidence: ConfidenceLevel;
  ragSources: RagSourceUsed[];
  /** ID estable para que el feedback pueda referenciarlo y se ajusten scores */
  responseId: string;
}

export interface ClaudeChatInput {
  userMessage: string;
  user: string;
  module: string;
  client: string;
  environment: string;
  attachments?: Attachment[];
}

// Tipos Part compatibles con @google/genai
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

interface PreparedRequest {
  model: string;
  systemPrompt: string;
  contents: string | GeminiPart[];
  ragChunks: Awaited<ReturnType<typeof retrieveRelevantChunks>>;
  /** IDs de Q&A y KB items inyectados como few-shot — usado por response provenance */
  fewShotQaIds: string[];
  fewShotItemIds: string[];
}

async function prepareRequest(input: ClaudeChatInput): Promise<PreparedRequest> {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const baseSystemPrompt = await loadSystemPrompt();

  // Few-shot dinámico: Q&A aprobadas + KB items publicados que matchean
  // léxicamente la query del usuario. Se concatena al system prompt si hay
  // resultados, sino no afecta nada.
  const { buildFewShotBlock } = await import("./few-shot.service");
  const fewShot = await buildFewShotBlock(input.userMessage, input.module).catch((err) => {
    logger.debug({ err }, "few-shot fail (continuo sin)");
    return { block: "", qaIds: [] as string[], itemIds: [] as string[] };
  });
  const systemPrompt = fewShot.block
    ? `${baseSystemPrompt}\n${fewShot.block}`
    : baseSystemPrompt;

  const ragChunks = await retrieveRelevantChunks(input.userMessage, {
    module: input.module,
    client: input.client,
  }).catch((err) => {
    logger.warn({ err }, "RAG retrieve fail, sigo sin contexto");
    return [];
  });
  const ragBlock = formatContextBlock(ragChunks);

  const headerParts = [
    `Usuario: ${input.user}`,
    `Cliente: ${input.client}`,
    `Módulo SAP: ${input.module}`,
    `Ambiente: ${input.environment}`,
    "",
  ];
  if (ragBlock) headerParts.push(ragBlock);
  headerParts.push("Mensaje:");
  headerParts.push(input.userMessage);
  const headerText = headerParts.join("\n");

  const attachments = input.attachments ?? [];
  let contents: string | GeminiPart[];
  if (attachments.length === 0) {
    contents = headerText;
  } else {
    const parts: GeminiPart[] = [
      { text: headerText },
      {
        text:
          `\nEl usuario adjuntó ${attachments.length} imagen(es). ` +
          `Analízalas como evidencia técnica del incidente (capturas SAP, logs, dumps, mensajes de error). ` +
          `Si ves códigos de error, transacciones o nombres de objetos en la imagen, ` +
          `úsalos para enriquecer el diagnóstico en los 12 bloques.`,
      },
    ];
    for (const a of attachments) {
      parts.push({
        inlineData: { mimeType: a.mimeType, data: a.dataBase64 },
      });
    }
    contents = parts;
  }
  return { model, systemPrompt, contents, ragChunks, fewShotQaIds: fewShot.qaIds, fewShotItemIds: fewShot.itemIds };
}

function ragSourcesFromChunks(chunks: Awaited<ReturnType<typeof retrieveRelevantChunks>>): RagSourceUsed[] {
  return chunks.map((c) => ({
    documentId: c.documentId,
    sourceFile: c.sourceFile,
    chunkIndex: c.chunkIndex,
    score: c.score,
  }));
}

export async function chatWithAgent(input: ClaudeChatInput): Promise<ClaudeChatResult> {
  const ai = getClient();
  const { model, systemPrompt, contents, ragChunks, fewShotQaIds, fewShotItemIds } = await prepareRequest(input);

  logger.info(
    { model, module: input.module, environment: input.environment, attachmentCount: input.attachments?.length ?? 0 },
    "LLM request"
  );

  try {
    // v0.12.3 — Hard cap defensivo. Throws GeminiRateLimitExceeded si excede.
    assertCanCallGemini("chatWithAgent");
    const resp = await retryWithBackoff(
      () => ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 4096,
          temperature: 0.4,
        },
      }),
      { label: "gemini.generateContent", retries: 3 }
    );

    const text = (resp.text ?? "").trim();
    if (!text) {
      throw new ClaudeError("Respuesta vacía del modelo");
    }

    const usage = extractUsage(resp);
    recordUsageFireAndForget({
      source: "chat",
      model,
      promptTokens:     usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens:      usage.totalTokens,
      metadata: { module: input.module, client: input.client },
    });

    // Provenance: vincular respuesta con sus fuentes (Q&A few-shot, items
    // y RAG docs) para que el feedback pueda ajustar scores después.
    const responseId = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const ragDocIds = Array.from(new Set(ragChunks.map((c) => c.documentId)));
    try {
      const { recordProvenance } = await import("./provenance.service");
      await recordProvenance({
        responseId,
        qaIds: fewShotQaIds,
        itemIds: fewShotItemIds,
        ragDocIds,
        userQuery: input.userMessage,
        module: input.module,
      });
    } catch (err) {
      logger.debug({ err }, "provenance.record fail (continuo)");
    }

    // Hallucination check fire-and-forget — no bloquea la respuesta
    (async () => {
      try {
        const { checkHallucinations } = await import("./hallucination-detector.service");
        await checkHallucinations({
          responseId,
          userQuery: input.userMessage,
          responseText: text,
        });
      } catch (err) {
        logger.debug({ err }, "hallucination check fail");
      }
    })();

    return {
      text,
      model,
      confidence: detectConfidence(text),
      ragSources: ragSourcesFromChunks(ragChunks),
      responseId,
    };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    logger.error({ err }, "Error llamando a Gemini");
    throw new ClaudeError("Error procesando la solicitud del agente AMS", err);
  }
}

// ============================================================
// Streaming: AsyncIterable de chunks de texto
// ============================================================
export interface StreamChunk {
  type: "delta";
  text: string;
}

export interface StreamDone {
  type: "done";
  fullText: string;
  model: string;
  confidence: ConfidenceLevel;
  ragSources: RagSourceUsed[];
  responseId: string;
}

export type StreamEvent = StreamChunk | StreamDone;

/**
 * Devuelve un async iterable. Cada `delta` es un fragmento de texto;
 * el último evento es `done` con el texto completo + metadata.
 * Los errores se propagan como excepción (el caller decide cómo notificar).
 */
export async function* chatWithAgentStream(input: ClaudeChatInput): AsyncGenerator<StreamEvent, void, unknown> {
  const ai = getClient();
  const { model, systemPrompt, contents, ragChunks, fewShotQaIds, fewShotItemIds } = await prepareRequest(input);

  logger.info(
    { model, module: input.module, environment: input.environment, attachmentCount: input.attachments?.length ?? 0 },
    "LLM stream request"
  );

  let stream;
  try {
    stream = await retryWithBackoff(
      () => ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 4096,
          temperature: 0.4,
        },
      }),
      { label: "gemini.generateContentStream", retries: 3 }
    );
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    logger.error({ err }, "Error iniciando stream a Gemini");
    throw new ClaudeError("Error procesando la solicitud del agente AMS", err);
  }

  let buffer = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastUsageChunk: any = null;
  try {
    for await (const chunk of stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = chunk as any;
      const piece = c.text as string | undefined;
      if (c.usageMetadata) lastUsageChunk = c;
      if (piece) {
        buffer += piece;
        yield { type: "delta", text: piece };
      }
    }
  } catch (err) {
    logger.error({ err }, "Error durante stream de Gemini");
    throw new ClaudeError("Error procesando la solicitud del agente AMS (stream)", err);
  }

  const fullText = buffer.trim();
  if (!fullText) {
    throw new ClaudeError("Respuesta vacía del modelo");
  }

  const usage = extractUsage(lastUsageChunk);
  recordUsageFireAndForget({
    source: "chat",
    model,
    promptTokens:     usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens:      usage.totalTokens,
    metadata: { module: input.module, client: input.client, streaming: true },
  });

  // Provenance + responseId también en streaming
  const responseId = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const ragDocIds = Array.from(new Set(ragChunks.map((c) => c.documentId)));
  try {
    const { recordProvenance } = await import("./provenance.service");
    await recordProvenance({
      responseId,
      qaIds: fewShotQaIds,
      itemIds: fewShotItemIds,
      ragDocIds,
      userQuery: input.userMessage,
      module: input.module,
    });
  } catch (err) {
    logger.debug({ err }, "provenance.record stream fail (continuo)");
  }

  yield {
    type: "done",
    fullText,
    model,
    confidence: detectConfidence(fullText),
    ragSources: ragSourcesFromChunks(ragChunks),
    responseId,
  };
}
