// =============================================================================
// investigate.service.ts — Reinvestigación completa del caso (RE-R2)
// =============================================================================
// Ejecuta una investigación NUEVA sobre el caso: ensambla el paquete de
// evidencia (investigation-context) y lo manda a Gemini estructurado con el
// prompt "nueva investigación" (ignorá conclusiones previas, reconstruí
// hipótesis, evidencia nueva > supuestos). NUNCA reusa la respuesta previa —
// sólo la evidencia. Si Gemini falla → ok:false y el caller mantiene su
// análisis determinístico como fallback.
// =============================================================================

import { logger } from "../utils/logger";
import { recordAuditEvent } from "./audit-events.service";
import { buildInvestigationContext } from "./investigation-context.service";
import { callGeminiStructured, StructuredCallError } from "./gemini-structured.service";

export interface InvestigateOptions {
  actor?: string;
  /** Fuerza razonamiento fresco (salta el cache de 24h). Default true. */
  force?: boolean;
}

export interface InvestigateResult {
  ok: boolean;
  /** JSON estructurado de 10 secciones (ver INVESTIGATION_SCHEMA). Null si falló. */
  investigation: Record<string, unknown> | null;
  evidenceFingerprint: string | null;
  counts?: { artifacts: number; timelineEvents: number; priorVersions: number; memoryHits: number };
  model?: string;
  durationMs?: number;
  /** Razón si ok=false. */
  reason?: string;
}

export async function investigateTicket(
  tenantId: string,
  key: string,
  opts: InvestigateOptions = {},
): Promise<InvestigateResult | null> {
  const ctx = await buildInvestigationContext(tenantId, key);
  if (!ctx) return null; // ticket no existe

  try {
    const result = await callGeminiStructured<Record<string, unknown>>({
      taskType: "INVESTIGATION",
      userMessage: `Conducí una investigación NUEVA y completa del caso ${key} usando el paquete de evidencia provisto. Devolvé sólo el JSON.`,
      placeholders: { INVESTIGATION_CONTEXT: ctx.promptText },
      tenantId,
      bypassCache: opts.force !== false, // por defecto no cachea el reanálisis
      audit: { ticketKey: key, actor: opts.actor ?? "system" },
    });

    // Evento de reinvestigación en el timeline del caso (best-effort).
    await recordAuditEvent({
      tenantId,
      ticketId: key,
      actorName: opts.actor ?? "system",
      eventType: "INTELLIGENCE_ANALYSIS_RUN",
      category: "intelligence",
      severity: "info",
      source: "agent",
      payload: {
        title: "Reinvestigación completa ejecutada",
        model: result.modelUsed,
        durationMs: result.durationMs,
        evidence: ctx.counts,
        rootCauseChanged: (result.data?.changesVsPrevious as Record<string, unknown> | undefined)?.rootCauseChanged ?? null,
      },
    }).catch(() => { /* best-effort */ });

    return {
      ok: true,
      investigation: result.data,
      evidenceFingerprint: ctx.evidenceFingerprint,
      counts: ctx.counts,
      model: result.modelUsed,
      durationMs: result.durationMs,
    };
  } catch (err) {
    const reason = err instanceof StructuredCallError ? err.reason : "unknown";
    logger.warn({ err, key, reason }, "investigateTicket: LLM failed, caller usa fallback determinístico");
    return {
      ok: false,
      investigation: null,
      evidenceFingerprint: ctx.evidenceFingerprint,
      counts: ctx.counts,
      reason,
    };
  }
}
