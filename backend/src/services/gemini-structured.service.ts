// =============================================================================
// gemini-structured.service.ts v0.13 — Wrapper estructurado sobre Gemini
// =============================================================================
// Contrato nuevo para tareas que esperan JSON ajustado a schema:
//   - selecciona model + temperature + maxOutputTokens vía task-router
//   - carga prompt pack vía prompt-loader (system_base + task pack)
//   - sustituye placeholders {{KEY}}
//   - pide structured output (responseMimeType + responseSchema)
//   - parsea o repara JSON inválido (1 retry)
//   - emite audit events GEMINI_CALL_* (frontend los lee al refrescar)
//   - si todo falla → caller decide fallback (devuelve null + razón)
//
// NO reemplaza el chatWithAgent() libre — convive en paralelo.
// =============================================================================

import { GoogleGenAI } from "@google/genai";
import { logger } from "../utils/logger";
import { recordAuditEvent } from "./audit-events.service";
import { selectModelForTask, isMockMode, type LLMTaskType, type TaskRouteContext } from "../intelligence/task-router";
import { loadPromptForTask, fillPlaceholders } from "./prompt-loader";
import { SCHEMA_BY_TASK } from "../schemas/gemini-schemas";
import { parseOrRepair, RepairFailedError } from "./parse-or-repair";
import { ConfigError } from "../utils/errors";
import {
  geminiCallsTotal, geminiJsonInvalidTotal, geminiRepairAttemptsTotal,
  geminiCallDuration, geminiFallbackUsedTotal, geminiConfidenceLevel,
} from "../utils/metrics";
import { assertCanCallGemini } from "../utils/gemini-rate-limiter";

let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ConfigError("GEMINI_API_KEY no está configurada");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

export interface StructuredCallInput {
  /** Tipo de tarea — determina prompt pack + schema + model config. */
  taskType: LLMTaskType;
  /** Texto de user message (después del system prompt). */
  userMessage: string;
  /** Placeholders del prompt pack — {{TICKET_CONTEXT}}, {{RAG_CONTEXT}}, etc. */
  placeholders?: Record<string, string>;
  /** Audit metadata: actor, source ticket, etc. */
  audit?: {
    ticketKey?: string;
    actor?: string;
    correlationId?: string;
  };
  /** Override modelo / mock mode. */
  ctx?: TaskRouteContext;
}

export interface StructuredCallResult<T> {
  /** El JSON parseado y tipado. */
  data: T;
  /** Si hubo que reparar el JSON. */
  repaired: boolean;
  /** Modelo Gemini usado. */
  modelUsed: string;
  /** Si se cayó a mock (no llamó Gemini real). */
  wasMock: boolean;
  /** Duración total ms. */
  durationMs: number;
}

export class StructuredCallError extends Error {
  constructor(message: string, public readonly reason: "config" | "api" | "json_invalid" | "timeout" | "mock_no_fallback") {
    super(message);
  }
}

/**
 * Llama a Gemini con structured output. Devuelve JSON parseado y validado por schema.
 * Lanza StructuredCallError si todo falla (caller hace fallback determinístico).
 */
export async function callGeminiStructured<T = unknown>(
  input: StructuredCallInput,
): Promise<StructuredCallResult<T>> {
  const t0 = Date.now();
  const cfg = selectModelForTask(input.taskType, input.ctx);
  const correlationId = input.audit?.correlationId ?? `gemini-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  // Audit: STARTED
  await safeAudit({
    eventType: "GEMINI_CALL_STARTED",
    actor: input.audit?.actor ?? "system",
    title: `Gemini ${input.taskType} llamado`,
    ticketId: input.audit?.ticketKey,
    metadata: {
      taskType: input.taskType,
      model: cfg.model,
      promptPack: cfg.promptPack,
      correlationId,
    },
  });

  // Mock mode
  if (isMockMode(input.ctx)) {
    geminiFallbackUsedTotal.inc({ task_type: input.taskType, reason: "force_mock" });
    await safeAudit({
      eventType: "GEMINI_FALLBACK_USED",
      actor: input.audit?.actor ?? "system",
      title: `Gemini MOCK forzado (taskType=${input.taskType})`,
      ticketId: input.audit?.ticketKey,
      metadata: { reason: "force_mock", correlationId },
    });
    throw new StructuredCallError("Mock mode activo — caller debe usar fallback determinístico", "mock_no_fallback");
  }

  try {
    const systemPrompt = await loadPromptForTask(cfg.promptPack);
    const userText = input.placeholders
      ? fillPlaceholders(input.userMessage, input.placeholders)
      : input.userMessage;
    const systemFilled = input.placeholders
      ? fillPlaceholders(systemPrompt, input.placeholders)
      : systemPrompt;

    const client = getClient();
    const schema = SCHEMA_BY_TASK[input.taskType];

    // v0.12.3 — Hard cap defensivo (200/día, 80/hora, 20/min default).
    assertCanCallGemini(`structured:${input.taskType}`);
    const resp = await client.models.generateContent({
      model: cfg.model,
      contents: [{ role: "user", parts: [{ text: userText }] }],
      config: {
        systemInstruction: systemFilled,
        temperature: cfg.temperature,
        maxOutputTokens: cfg.maxOutputTokens,
        ...(cfg.jsonOutput ? { responseMimeType: "application/json" } : {}),
        ...(schema ? { responseSchema: schema } : {}),
      },
    });

    const rawText = resp.text ?? "";

    // FIX M13 (audit v1.1.0): chequear finishReason. Si Gemini bloqueó por SAFETY
    // u OTHER, NO devolver string vacío como respuesta válida — tirar para que
    // el caller maneje (vs ticket queda "enriched" con análisis fantasma).
    const finishReason = (resp as { candidates?: Array<{ finishReason?: string }> }).candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP" && finishReason !== "MAX_TOKENS") {
      throw new Error(`Gemini blocked response: finishReason=${finishReason}`);
    }

    if (!cfg.jsonOutput) {
      // No structured — devolvemos string como T (caller responsable)
      const durationMs = Date.now() - t0;
      await safeAudit({
        eventType: "GEMINI_CALL_COMPLETED",
        actor: input.audit?.actor ?? "system",
        title: `Gemini ${input.taskType} completado (texto libre)`,
        ticketId: input.audit?.ticketKey,
        metadata: { taskType: input.taskType, model: cfg.model, durationMs, structured: false, correlationId },
      });
      return {
        data: rawText as unknown as T,
        repaired: false,
        modelUsed: cfg.model,
        wasMock: false,
        durationMs,
      };
    }

    // Structured — parse o repair
    let parseResult: { parsed: T; repaired: boolean };
    try {
      parseResult = await parseOrRepair<T>(rawText, {
        client,
        model: cfg.model,
        responseSchema: schema,
        taskType: input.taskType,
      });
    } catch (repairErr) {
      // Capturamos para meter métricas antes de re-throw
      if (repairErr instanceof RepairFailedError) {
        geminiJsonInvalidTotal.inc({ task_type: input.taskType });
        geminiRepairAttemptsTotal.inc({ task_type: input.taskType, outcome: "failed" });
      }
      throw repairErr;
    }
    const { parsed, repaired } = parseResult;
    if (repaired) {
      geminiJsonInvalidTotal.inc({ task_type: input.taskType });
      geminiRepairAttemptsTotal.inc({ task_type: input.taskType, outcome: "success" });
    }

    const durationMs = Date.now() - t0;
    geminiCallsTotal.inc({ task_type: input.taskType, model: cfg.model, result: "success" });
    geminiCallDuration.observe({ task_type: input.taskType, model: cfg.model }, durationMs / 1000);

    // Extraer confidence si la respuesta lo trae
    const conf = (parsed as { confidence?: string } | null)?.confidence;
    if (conf && ["alta", "media", "baja"].includes(conf)) {
      geminiConfidenceLevel.inc({ task_type: input.taskType, level: conf });
    }

    await safeAudit({
      eventType: "GEMINI_CALL_COMPLETED",
      actor: input.audit?.actor ?? "system",
      title: `Gemini ${input.taskType} completado${repaired ? " (con reparación JSON)" : ""}`,
      ticketId: input.audit?.ticketKey,
      metadata: { taskType: input.taskType, model: cfg.model, durationMs, repaired, confidence: conf, correlationId },
    });

    return { data: parsed, repaired, modelUsed: cfg.model, wasMock: false, durationMs };

  } catch (err) {
    const durationMs = Date.now() - t0;
    const errMsg = (err as Error).message;
    const isRepairFail = err instanceof RepairFailedError;
    const reason: StructuredCallError["reason"] = isRepairFail ? "json_invalid"
      : err instanceof ConfigError ? "config"
      : "api";

    geminiCallsTotal.inc({ task_type: input.taskType, model: cfg.model, result: reason });
    geminiFallbackUsedTotal.inc({ task_type: input.taskType, reason });

    logger.error({ err, taskType: input.taskType, durationMs, correlationId }, "Gemini structured call failed");

    await safeAudit({
      eventType: "GEMINI_CALL_FAILED",
      actor: input.audit?.actor ?? "system",
      title: `Gemini ${input.taskType} falló: ${errMsg.slice(0, 80)}`,
      ticketId: input.audit?.ticketKey,
      metadata: { taskType: input.taskType, reason, durationMs, error: errMsg, correlationId },
    });

    throw new StructuredCallError(errMsg, reason);
  }
}

// =============================================================================
// safeAudit — wrapper que no rompe el flow si la tabla audit_events no existe
// =============================================================================

async function safeAudit(input: {
  eventType: string;
  actor: string;
  title: string;
  ticketId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordAuditEvent({
      eventType: input.eventType,
      category: "gemini",
      severity: input.eventType.endsWith("FAILED") ? "warning" : "info",
      actorName: input.actor,
      actorRole: "system",
      source: "agent",
      ticketId: input.ticketId,
      payload: { title: input.title, ...(input.metadata ?? {}) },
      correlationId: (input.metadata?.correlationId as string | undefined) ?? null,
    });
  } catch (err) {
    logger.debug({ err }, "audit event skipped (table may not exist)");
  }
}
