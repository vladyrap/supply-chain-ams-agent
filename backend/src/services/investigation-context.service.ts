// =============================================================================
// investigation-context.service.ts — Evidence Package para la reinvestigación
// =============================================================================
// Ensambla TODO el material del caso en un único paquete de investigación que
// alimenta al LLM: ticket original + evidencia nueva (artefactos) + timeline +
// análisis previo (SÓLO como hipótesis a re-evaluar, nunca como respuesta a
// reusar) + Memoria Organizacional. Todo redactado (secretos/PII).
//
// Reuse-first: no crea almacenes nuevos — lee del substrato existente
// (case_artifacts, audit_events read-model, ticket_intelligence_history,
// memory_record). Devuelve el texto para el prompt + un fingerprint de evidencia
// para detectar "hay evidencia nueva desde el último análisis".
// =============================================================================

import { createHash } from "crypto";
import { logger } from "../utils/logger";
import { redactSecrets, redactedPreview } from "../utils/redact";
import { getTicketByKey, listIntelligenceHistory, getCaseTimeline } from "./ticket.service";
import { listCaseArtifacts } from "./case-artifacts.service";
import { retrieveMemory } from "./memory.service";

export interface InvestigationContext {
  ticketKey: string;
  /** Bloque de texto listo para {{INVESTIGATION_CONTEXT}}. */
  promptText: string;
  /** Hash de la evidencia disponible (artefactos + timeline + versiones). */
  evidenceFingerprint: string;
  counts: { artifacts: number; timelineEvents: number; priorVersions: number; memoryHits: number };
}

/** Resumen defensivo del análisis previo (JSON opaco) — sólo para RE-EVALUAR. */
function summarizePriorAnalysis(intel: unknown): string[] {
  const lines: string[] = [];
  const i = (intel ?? {}) as Record<string, unknown>;
  const a = (i.analysis ?? {}) as Record<string, unknown>;
  const ctx = (a.detectedContext ?? {}) as Record<string, unknown>;
  if (typeof a.readinessScore === "number") lines.push(`readiness previo: ${a.readinessScore}`);
  if (ctx.module) lines.push(`módulo detectado: ${ctx.module}`);
  if (ctx.errorCode) lines.push(`código de error: ${ctx.errorCode}`);
  if (ctx.issueType) lines.push(`tipo de incidencia: ${ctx.issueType}`);
  const nba = (a.nextBestAction ?? null) as Record<string, unknown> | null;
  if (nba && (nba.label || nba.action)) lines.push(`acción sugerida previa: ${nba.label ?? nba.action}`);
  const esc = a.escalationRecommendation;
  if (typeof esc === "string" && esc) lines.push(`escalamiento previo: ${esc}`);
  const spec = (i.specialistAnalysis ?? null) as Record<string, unknown> | null;
  const primary = (spec?.primaryAnalysis ?? null) as Record<string, unknown> | null;
  if (primary?.specialist) lines.push(`especialista previo: ${primary.specialist}`);
  return lines.map((l) => redactSecrets(l));
}

export async function buildInvestigationContext(
  tenantId: string,
  key: string,
): Promise<InvestigationContext | null> {
  const ticket = await getTicketByKey(tenantId, key);
  if (!ticket) return null;

  const memQuery = `${ticket.title} ${ticket.description}`.slice(0, 400);
  const [artifacts, timeline, history, memory] = await Promise.all([
    listCaseArtifacts(tenantId, key).catch(() => []),
    getCaseTimeline(tenantId, key, { limit: 60 }).catch(() => null),
    listIntelligenceHistory(tenantId, key).catch(() => []),
    retrieveMemory(tenantId, memQuery, { limit: 6 }).catch(() => null),
  ]);

  const parts: string[] = [];

  // 1) Ticket original
  parts.push(
    "### TICKET ORIGINAL",
    `- Key: ${ticket.key}`,
    `- Título: ${redactSecrets(ticket.title)}`,
    `- Descripción: ${redactedPreview(ticket.description, 1500)}`,
    `- Módulo SAP: ${ticket.sapModule ?? "—"} · Ambiente: ${ticket.environment ?? "—"} · Prioridad: ${ticket.priority} · Estado: ${ticket.status}`,
  );

  // 2) Evidencia nueva (artefactos de 1ª clase — ya redactados al persistir)
  parts.push("", "### EVIDENCIA NUEVA (artefactos del caso)");
  if (artifacts.length === 0) {
    parts.push("(sin artefactos registrados)");
  } else {
    for (const art of artifacts.slice(0, 40)) {
      const ref = art.ref ? ` · ref: ${redactSecrets(art.ref)}` : "";
      const content = art.content ? ` — ${redactedPreview(art.content, 600)}` : "";
      parts.push(`- [${art.kind}] ${redactSecrets(art.title)}${ref}${content}`);
    }
  }

  // 3) Timeline del caso (hechos, más reciente primero)
  parts.push("", "### TIMELINE DEL CASO (eventos)");
  const items = timeline?.items ?? [];
  if (items.length === 0) {
    parts.push("(sin eventos)");
  } else {
    for (const it of items.slice(0, 40)) {
      const desc = it.description ? ` — ${redactedPreview(it.description, 200)}` : "";
      parts.push(`- ${it.at} · ${it.eventType} · ${redactSecrets(it.title)}${desc}`);
    }
  }

  // 4) Análisis previo — SÓLO como hipótesis a RE-EVALUAR (nunca a reusar)
  parts.push("", "### ANÁLISIS PREVIO (v" + (history[0]?.version ?? 0) + ") — RE-EVALUAR, PUEDE SER INVÁLIDO");
  if (history.length === 0) {
    parts.push("(sin versiones previas — primera investigación)");
  } else {
    const prior = summarizePriorAnalysis(history[0].intelligence);
    if (prior.length === 0) parts.push("(análisis previo sin datos estructurados)");
    else prior.forEach((l) => parts.push(`- ${l}`));
    parts.push(
      "IMPORTANTE: lo anterior es la conclusión previa. NO la reuses como respuesta; " +
      "re-evaluala con la evidencia completa y descartala si la evidencia nueva la contradice.",
    );
  }

  // 5) Memoria Organizacional (lecciones/casos relacionados)
  parts.push("", "### MEMORIA ORGANIZACIONAL (casos/lecciones relacionadas)");
  const hits = (memory?.results ?? []) as unknown as Array<Record<string, unknown>>;
  if (hits.length === 0) {
    parts.push("(sin coincidencias en memoria)");
  } else {
    for (const h of hits.slice(0, 6)) {
      const title = typeof h.title === "string" ? h.title : "(sin título)";
      const body = typeof h.body === "string" ? h.body : "";
      const kind = typeof h.kind === "string" ? `[${h.kind}] ` : "";
      parts.push(`- ${kind}${redactSecrets(title)}${body ? " — " + redactedPreview(body, 240) : ""}`);
    }
  }

  const promptText = parts.join("\n");

  // Fingerprint de evidencia: SÓLO lo que agrega el usuario (artefactos: id+hash).
  // NO incluye timeline/versiones/latestEvent, que MUTAN en cada investigación
  // (cada corrida emite eventos + snapshotea una versión). Así "misma evidencia
  // → mismo fingerprint" y la idempotencia del PUT evita versiones espurias.
  const fpSource = JSON.stringify({
    artifacts: artifacts.map((a) => `${a.id}:${a.contentHash ?? ""}`).sort(),
  });
  const evidenceFingerprint = createHash("sha256").update(fpSource).digest("hex").slice(0, 24);

  logger.debug({ key, artifacts: artifacts.length, timeline: items.length, versions: history.length }, "investigation context built");

  return {
    ticketKey: key,
    promptText,
    evidenceFingerprint,
    counts: {
      artifacts: artifacts.length,
      timelineEvents: items.length,
      priorVersions: history.length,
      memoryHits: hits.length,
    },
  };
}
