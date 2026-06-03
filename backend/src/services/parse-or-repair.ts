// =============================================================================
// parse-or-repair v0.13 — Parse JSON con 1 retry de reparación
// =============================================================================
// Cuando Gemini devuelve texto que dice ser JSON pero no parsea:
//   1. Intenta JSON.parse directo
//   2. Si falla, intenta limpiar markdown wrapping (```json ... ```)
//   3. Si falla, ejecuta 1 retry pidiendo a Gemini "tu respuesta anterior no
//      era JSON válido, devolvé SOLO JSON sin texto adicional"
//   4. Si vuelve a fallar → throw RepairFailedError → caller hace fallback
// =============================================================================

import type { GoogleGenAI, Schema } from "@google/genai";
import { logger } from "../utils/logger";

export class RepairFailedError extends Error {
  constructor(public readonly originalText: string, public readonly retryText?: string) {
    super("JSON repair failed after 1 retry");
  }
}

/** Limpia el wrapping markdown común que mete Gemini cuando le pedís JSON. */
function stripMarkdownWrapping(text: string): string {
  let cleaned = text.trim();
  // ```json ... ```
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  // a veces solo retorna ``` sin lenguaje
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\w*\s*/, "").replace(/\s*```$/, "");
  }
  return cleaned;
}

/** Intento de parseo "blando": directo + clean markdown. */
function tryParseDirect<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch { /* fallthrough */ }
  try {
    const cleaned = stripMarkdownWrapping(text);
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

export interface RepairOptions {
  client: GoogleGenAI;
  model: string;
  /** Schema opcional para el retry. */
  responseSchema?: Schema;
  /** Para logs / metrics. */
  taskType?: string;
}

/**
 * Parsea texto Gemini como JSON. Si falla, hace 1 retry pidiendo solo JSON
 * con mensaje explícito. Si vuelve a fallar, throw RepairFailedError.
 */
export async function parseOrRepair<T>(
  rawText: string,
  opts: RepairOptions,
): Promise<{ parsed: T; repaired: boolean }> {
  // Intento 1: directo
  const direct = tryParseDirect<T>(rawText);
  if (direct !== null) {
    return { parsed: direct, repaired: false };
  }

  logger.warn({
    taskType: opts.taskType,
    rawPreview: rawText.slice(0, 200),
  }, "Gemini returned invalid JSON, attempting 1 repair");

  // Intento 2: retry con prompt explícito
  const repairPrompt = [
    "Tu respuesta anterior no era JSON válido. Te paso lo que devolviste:",
    "```",
    rawText.slice(0, 4000),
    "```",
    "",
    "Devolvé SOLAMENTE el JSON válido pedido. Sin texto adicional. Sin markdown. Sin explicaciones.",
    "Empezá directamente con `{`.",
  ].join("\n");

  try {
    const retryResp = await opts.client.models.generateContent({
      model: opts.model,
      contents: [{ role: "user", parts: [{ text: repairPrompt }] }],
      config: {
        temperature: 0.1, // bajísima para forzar JSON literal
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
        ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
      },
    });
    const retryText = retryResp.text ?? "";
    const repaired = tryParseDirect<T>(retryText);
    if (repaired !== null) {
      logger.info({ taskType: opts.taskType }, "Gemini JSON repair succeeded on retry");
      return { parsed: repaired, repaired: true };
    }
    throw new RepairFailedError(rawText, retryText);
  } catch (err) {
    if (err instanceof RepairFailedError) throw err;
    logger.error({ err, taskType: opts.taskType }, "Gemini repair retry threw");
    throw new RepairFailedError(rawText);
  }
}
