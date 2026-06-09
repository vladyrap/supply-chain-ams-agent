// =============================================================================
// gemini-rate-limiter.ts — Hard cap defensivo (v0.12.3)
// =============================================================================
// Defensa de última línea contra cobros inesperados a Gemini API.
// Cuenta llamadas en 3 ventanas (minuto, hora, día) y rechaza con error
// específico si excede cualquiera. El caller debe catchear y devolver mock o
// fallback razonable.
//
// Razón: aunque tengamos budget cap en Google Cloud + tarjeta removida, esto
// previene loops en el código que podrían generar errores ANTES que Google
// alcance a cortarnos (los chequeos en GC tienen latencia).
//
// Caps default — pensados para uso normal AMS (~30-50 calls/día esperado):
//   - 20 calls / minuto  → evita bursts por bug
//   - 80 calls / hora    → evita worker descontrolado
//   - 200 calls / día    → tope absoluto, ~$2-5 USD/día max
//
// Override vía env vars: GEMINI_CAP_PER_MINUTE, GEMINI_CAP_PER_HOUR, GEMINI_CAP_PER_DAY
// Para deshabilitar: GEMINI_CAP_DISABLED=1 (NO recomendado en producción).
// =============================================================================

import { logger } from "./logger";

const CAP_PER_MINUTE = Number(process.env.GEMINI_CAP_PER_MINUTE ?? 20);
const CAP_PER_HOUR = Number(process.env.GEMINI_CAP_PER_HOUR ?? 80);
const CAP_PER_DAY = Number(process.env.GEMINI_CAP_PER_DAY ?? 200);
const DISABLED = process.env.GEMINI_CAP_DISABLED === "1";

let callsThisMinute = 0;
let callsThisHour = 0;
let callsToday = 0;
let minuteStart = Date.now();
let hourStart = Date.now();
let dayStart = Date.now();

function rollWindows(): void {
  const now = Date.now();
  if (now - minuteStart >= 60_000) {
    callsThisMinute = 0;
    minuteStart = now;
  }
  if (now - hourStart >= 3_600_000) {
    callsThisHour = 0;
    hourStart = now;
  }
  if (now - dayStart >= 86_400_000) {
    callsToday = 0;
    dayStart = now;
    logger.info({ cap: CAP_PER_DAY }, "gemini rate-limiter: nuevo día, contador reseteado");
  }
}

export type RateLimitWindow = "minute" | "hour" | "day";

export class GeminiRateLimitExceeded extends Error {
  constructor(
    public readonly window: RateLimitWindow,
    public readonly count: number,
    public readonly cap: number,
  ) {
    super(
      `Gemini rate limit excedido (${window}): ${count}/${cap}. ` +
      `Defensa local para prevenir costos inesperados. ` +
      `Ajustá con GEMINI_CAP_PER_${window.toUpperCase()} env var.`,
    );
    this.name = "GeminiRateLimitExceeded";
  }
}

/**
 * Llamar ANTES de cada `ai.models.generateContent()`.
 * Throws `GeminiRateLimitExceeded` si excede cualquier cap.
 * Incrementa los contadores si pasa los checks.
 */
export function assertCanCallGemini(label = "unknown"): void {
  if (DISABLED) return;
  rollWindows();

  if (callsThisMinute >= CAP_PER_MINUTE) {
    logger.warn(
      { label, callsThisMinute, cap: CAP_PER_MINUTE },
      "gemini rate-limiter: cap por minuto alcanzado, rechazando llamada",
    );
    throw new GeminiRateLimitExceeded("minute", callsThisMinute, CAP_PER_MINUTE);
  }
  if (callsThisHour >= CAP_PER_HOUR) {
    logger.warn(
      { label, callsThisHour, cap: CAP_PER_HOUR },
      "gemini rate-limiter: cap por hora alcanzado, rechazando llamada",
    );
    throw new GeminiRateLimitExceeded("hour", callsThisHour, CAP_PER_HOUR);
  }
  if (callsToday >= CAP_PER_DAY) {
    logger.warn(
      { label, callsToday, cap: CAP_PER_DAY },
      "gemini rate-limiter: cap por día alcanzado, rechazando llamada",
    );
    throw new GeminiRateLimitExceeded("day", callsToday, CAP_PER_DAY);
  }

  callsThisMinute += 1;
  callsThisHour += 1;
  callsToday += 1;
}

/**
 * Stats actuales (para endpoints de monitoreo).
 */
export function getGeminiRateLimitStats(): {
  enabled: boolean;
  caps: { minute: number; hour: number; day: number };
  current: { minute: number; hour: number; day: number };
  remaining: { minute: number; hour: number; day: number };
} {
  rollWindows();
  return {
    enabled: !DISABLED,
    caps: { minute: CAP_PER_MINUTE, hour: CAP_PER_HOUR, day: CAP_PER_DAY },
    current: { minute: callsThisMinute, hour: callsThisHour, day: callsToday },
    remaining: {
      minute: Math.max(0, CAP_PER_MINUTE - callsThisMinute),
      hour: Math.max(0, CAP_PER_HOUR - callsThisHour),
      day: Math.max(0, CAP_PER_DAY - callsToday),
    },
  };
}

/**
 * Reset manual (testing / admin endpoint).
 */
export function resetGeminiRateLimit(): void {
  callsThisMinute = 0;
  callsThisHour = 0;
  callsToday = 0;
  minuteStart = Date.now();
  hourStart = Date.now();
  dayStart = Date.now();
  logger.info("gemini rate-limiter: contadores reseteados manualmente");
}
