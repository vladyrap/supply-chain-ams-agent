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

// Cache del prompt activo de DB (TTL 60s, por tenant — MT-3).
// Cada tenant puede tener su prompt activo, así que el cache también
// se segmenta por tenant.
const cachedActivePromptByTenant = new Map<string, { text: string; label: string; expiresAt: number }>();
const ACTIVE_PROMPT_TTL_MS = 60_000;

async function getActiveOverride(tenantId: string): Promise<{ text: string; label: string } | null> {
  const cached = cachedActivePromptByTenant.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.text ? { text: cached.text, label: cached.label } : null;
  }
  try {
    // Import dinámico para evitar ciclo (agent-lab también importa cosas del agente).
    const { getActivePrompt } = await import("./agent-lab.service");
    const row = await getActivePrompt(tenantId);
    if (row && row.system_prompt) {
      cachedActivePromptByTenant.set(tenantId, {
        text: row.system_prompt,
        label: row.label,
        expiresAt: Date.now() + ACTIVE_PROMPT_TTL_MS,
      });
      return { text: row.system_prompt, label: row.label };
    }
    cachedActivePromptByTenant.set(tenantId, { text: "", label: "", expiresAt: Date.now() + ACTIVE_PROMPT_TTL_MS });
    return null;
  } catch (err) {
    // Si la tabla no existe todavía (primer arranque sin Playground usado),
    // simplemente no hay override.
    logger.debug({ err, tenantId }, "agent_prompt_versions no disponible — fallback a archivo");
    return null;
  }
}

/** Permite invalidar el cache desde otros lugares (p.ej. tras adoptar). */
export function invalidateActivePromptCache(): void {
  cachedActivePromptByTenant.clear();
}

async function loadSystemPrompt(tenantId: string): Promise<string> {
  // 1) Si hay un prompt adoptado activo en DB para este tenant, ese gana.
  const override = await getActiveOverride(tenantId);
  if (override) {
    logger.info({ active: override.label, tenantId }, "agente usa prompt adoptado del Playground");
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
  /**
   * Multi-tenant scope. Si el caller no lo provee, se usa "default" — esto
   * solo debería pasar en path de tests o callers internos sin contexto HTTP.
   * Los controllers HTTP deberían pasar req.tenantId siempre.
   */
  tenantId?: string;
  /**
   * v1.3 Agent Hub — instrucciones de un agente custom. Si viene, reemplaza
   * el system prompt base del tenant. Few-shot + RAG siguen aplicando igual,
   * scoped al módulo del agente.
   */
  systemPromptOverride?: string;
  /**
   * v1.3 onda 4.1 — modelo elegido por el agente custom. Si empieza con
   * "claude-" se enruta a la API de Anthropic (requiere ANTHROPIC_API_KEY);
   * cualquier otro valor va a Gemini. Sin override → GEMINI_MODEL/default.
   */
  modelOverride?: string;
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
  const model = input.modelOverride?.trim() || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  // MT-3: prompt activo es per-tenant. Si no viene tenantId (path interno),
  // se usa "default" — mismo fallback que few-shot / RAG.
  const promptTenantId = input.tenantId ?? "default";
  // v1.3 Agent Hub: un agente custom trae sus propias instrucciones.
  const baseSystemPrompt = input.systemPromptOverride?.trim()
    ? input.systemPromptOverride.trim()
    : await loadSystemPrompt(promptTenantId);

  // Few-shot dinámico: Q&A aprobadas + KB items publicados que matchean
  // léxicamente la query del usuario. Se concatena al system prompt si hay
  // resultados, sino no afecta nada.
  const { buildFewShotBlock } = await import("./few-shot.service");
  // MT-2: tenantId obligatorio en buildFewShotBlock para aislar conocimiento
  // por cliente. Si el caller no lo provee usamos "default" — esto pasa solo
  // en paths sin contexto HTTP (tests, eval interno). TODO MT-6: hacer
  // tenantId required en ClaudeChatInput una vez todos los callers (eval,
  // testing, etc.) pasen el suyo desde su contexto.
  const fewShotTenantId = input.tenantId ?? "default";
  const fewShot = await buildFewShotBlock(fewShotTenantId, input.userMessage, input.module).catch((err) => {
    logger.debug({ err }, "few-shot fail (continuo sin)");
    return { block: "", qaIds: [] as string[], itemIds: [] as string[] };
  });
  const systemPrompt = fewShot.block
    ? `${baseSystemPrompt}\n${fewShot.block}`
    : baseSystemPrompt;

  // MT-3: RAG aislado por tenant. Mismo fallback que few-shot ("default")
  // mientras callers internos (eval, tests) migran a pasar su tenantId.
  const ragTenantId = input.tenantId ?? "default";
  const ragChunks = await retrieveRelevantChunks(ragTenantId, input.userMessage, {
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

// ============================================================
// Proveedor Anthropic (v1.3 onda 4.1) — agentes con modelos Claude
// ============================================================

export function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}

interface AnthropicResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  contents: string | GeminiPart[],
): Promise<AnthropicResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ConfigError(
      "ANTHROPIC_API_KEY no está configurada en el backend — necesaria para agentes con modelos Claude (Opus/Sonnet/Haiku)",
    );
  }

  // Los contents vienen en formato Gemini — se convierten a bloques Anthropic.
  type AnthropicBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
  const blocks: AnthropicBlock[] = [];
  if (typeof contents === "string") {
    blocks.push({ type: "text", text: contents });
  } else {
    for (const p of contents) {
      if ("text" in p) {
        blocks.push({ type: "text", text: p.text });
      } else {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: p.inlineData.mimeType, data: p.inlineData.data },
        });
      }
    }
  }

  const resp = await retryWithBackoff(
    async () => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          temperature: 0.4,
          system: systemPrompt,
          messages: [{ role: "user", content: blocks }],
        }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        const err = new Error(`Anthropic HTTP ${r.status}: ${body.slice(0, 300)}`);
        (err as Error & { statusCode?: number }).statusCode = r.status;
        throw err;
      }
      return r.json() as Promise<{
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      }>;
    },
    { label: "anthropic.messages", retries: 3 },
  );

  const text = (resp.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
  return {
    text,
    promptTokens: resp.usage?.input_tokens ?? 0,
    completionTokens: resp.usage?.output_tokens ?? 0,
  };
}

export async function chatWithAgent(input: ClaudeChatInput): Promise<ClaudeChatResult> {
  const { model, systemPrompt, contents, ragChunks, fewShotQaIds, fewShotItemIds } = await prepareRequest(input);

  logger.info(
    { model, module: input.module, environment: input.environment, attachmentCount: input.attachments?.length ?? 0 },
    "LLM request"
  );

  try {
    // v0.12.3 — Hard cap defensivo diario. Aplica a TODOS los proveedores
    // (Gemini y Anthropic): protege el costo, no solo el free tier.
    assertCanCallGemini("chatWithAgent");

    let text: string;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    if (isClaudeModel(model)) {
      // v1.3 onda 4.1 — agente custom con modelo Claude (Anthropic API)
      const r = await callAnthropic(model, systemPrompt, contents);
      text = r.text;
      promptTokens = r.promptTokens;
      completionTokens = r.completionTokens;
      totalTokens = promptTokens + completionTokens;
    } else {
      const ai = getClient();
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
      text = (resp.text ?? "").trim();
      const usage = extractUsage(resp);
      promptTokens = usage.promptTokens;
      completionTokens = usage.completionTokens;
      totalTokens = usage.totalTokens;
    }

    if (!text) {
      throw new ClaudeError("Respuesta vacía del modelo");
    }

    recordUsageFireAndForget({
      source: "chat",
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      metadata: { module: input.module, client: input.client },
    });

    // Provenance: vincular respuesta con sus fuentes (Q&A few-shot, items
    // y RAG docs) para que el feedback pueda ajustar scores después.
    const responseId = `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const ragDocIds = Array.from(new Set(ragChunks.map((c) => c.documentId)));
    try {
      const { recordProvenance } = await import("./provenance.service");
      await recordProvenance(input.tenantId ?? "default", {
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

    // Hallucination check fire-and-forget — no bloquea la respuesta (scoped MT-3)
    const hallucTenantId = input.tenantId ?? "default";
    (async () => {
      try {
        const { checkHallucinations } = await import("./hallucination-detector.service");
        await checkHallucinations(hallucTenantId, {
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
    logger.error({ err }, "Error llamando al LLM");
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
    await recordProvenance(input.tenantId ?? "default", {
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
