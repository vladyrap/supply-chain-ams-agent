// Auto-detector de brechas de conocimiento.
//
// Analiza señales del sistema y propone KnowledgeGaps en la tabla
// kb_training_gaps para que el equipo AMS los acciones desde el
// Centro de Entrenamiento.
//
// Señales que usa:
//   1) Tickets RESUELTOS/CLOSED sin kb_article_id asociado → casos
//      cuya solución no quedó documentada.
//   2) Feedback humano negativo (ai_response_feedback.kind='negative')
//      en los últimos N días → respuestas del agente que fallaron.
//   3) Cobertura por módulo SAP (kb_training_items) — si un módulo SAP
//      aparece en >= 3 incidentes recientes pero tiene < 3 items
//      publicados, se reporta gap.
//
// Idempotencia: cada gap candidato tiene un "signature" (módulo + tipo
// de señal). Si ya existe un gap OPEN/IN_PROGRESS con esa signature,
// no se duplica.

import { query } from "../database/db";
import { logger } from "../utils/logger";
import * as training from "./training.service";

export interface GapDetectorReport {
  scannedAt: string;
  candidates: number;
  created: number;
  skipped: number;
  bySource: { source: string; count: number }[];
}

interface CandidateGap {
  signature: string;
  title: string;
  description: string;
  module: string;
  process: string;
  priority: "low" | "medium" | "high" | "critical";
  suggestedAction: string;
}

const PROCESS_BY_MODULE: Record<string, string> = {
  MM: "Compras", SD: "Ventas", PP: "Planificación", FI: "Costos", CO: "Costos",
  EWM: "Almacén", WM: "Almacén", TM: "Logística", "LE-TRA": "Logística",
  QM: "Calidad", PM: "Producción", IBP: "Planificación",
  BTP: "Integraciones", AMS: "AMS Genérico",
};

function processForModule(m: string | null | undefined): string {
  if (!m) return "AMS Genérico";
  return PROCESS_BY_MODULE[m.toUpperCase()] ?? "AMS Genérico";
}

/**
 * Detección 1: tickets resueltos/cerrados sin KB asociada en últimos N días.
 * Agrupa por módulo y genera un gap por módulo si hay ≥ 2 sin KB.
 */
async function detectTicketsWithoutKB(daysBack: number): Promise<CandidateGap[]> {
  const out: CandidateGap[] = [];
  try {
    const { rows } = await query<{ sap_module: string | null; n: string }>(
      `SELECT COALESCE(sap_module, 'AMS') AS sap_module, count(*)::text AS n
         FROM support_tickets
        WHERE status IN ('resolved','closed')
          AND kb_article_id IS NULL
          AND resolved_at > now() - ($1 || ' days')::interval
        GROUP BY sap_module
        HAVING count(*) >= 2`,
      [String(Math.max(1, daysBack))]
    );
    for (const r of rows) {
      const mod = r.sap_module || "AMS";
      const n = Number(r.n);
      out.push({
        signature: `tickets-no-kb:${mod}`,
        title: `${mod} · ${n} tickets resueltos en ${daysBack}d sin KB asociada`,
        description: `Se detectaron ${n} casos resueltos por Nivel 2 del módulo ${mod} en los últimos ${daysBack} días que no terminaron en un artículo de KB curada. La solución se está perdiendo.`,
        module: mod,
        process: processForModule(mod),
        priority: n >= 5 ? "high" : "medium",
        suggestedAction: `Revisar los tickets recientes del módulo ${mod} con el wizard ticket→KB del Agent Lab. Convertir al menos los ${Math.min(3, n)} más recurrentes en artículos curados.`,
      });
    }
  } catch (err) {
    logger.warn({ err }, "gap-detector.tickets fail");
  }
  return out;
}

/**
 * Detección 2: feedback humano negativo recurrente en últimos N días.
 * Agrupa por "razón" + source para encontrar patrones.
 */
async function detectNegativeFeedbackPatterns(daysBack: number): Promise<CandidateGap[]> {
  const out: CandidateGap[] = [];
  try {
    const { rows } = await query<{ source: string; n: string }>(
      `SELECT source, count(*)::text AS n
         FROM ai_response_feedback
        WHERE kind = 'negative'
          AND created_at > now() - ($1 || ' days')::interval
        GROUP BY source
        HAVING count(*) >= 3`,
      [String(Math.max(1, daysBack))]
    );
    for (const r of rows) {
      const n = Number(r.n);
      const sourceLabel =
        r.source === "support"    ? "Mesa de Soporte"
      : r.source === "agent_chat" ? "Chat del agente"
      : r.source === "voice"      ? "canal telefónico"
      : r.source;
      out.push({
        signature: `negative-feedback:${r.source}`,
        title: `${n} respuestas marcadas 👎 en ${sourceLabel} (${daysBack}d)`,
        description: `Los usuarios marcaron ${n} respuestas del agente como incorrectas en ${sourceLabel} durante los últimos ${daysBack} días. Patrón sostenido de baja calidad.`,
        module: "AMS",
        process: "AMS Genérico",
        priority: n >= 8 ? "critical" : n >= 5 ? "high" : "medium",
        suggestedAction: `Abrir Agent Lab → tab "Casos para curar". Revisar las respuestas negativas, crear KB articles correctos y validar con Playground una nueva variante del prompt.`,
      });
    }
  } catch (err) {
    logger.warn({ err }, "gap-detector.feedback fail");
  }
  return out;
}

/**
 * Detección 3: incidentes recurrentes en un módulo SAP que tiene baja
 * cobertura publicada en kb_training_items.
 */
async function detectLowCoverageHotModules(daysBack: number): Promise<CandidateGap[]> {
  const out: CandidateGap[] = [];
  try {
    const { rows: hot } = await query<{ sap_module: string | null; n: string }>(
      `SELECT COALESCE(sap_module, 'AMS') AS sap_module, count(*)::text AS n
         FROM support_tickets
        WHERE created_at > now() - ($1 || ' days')::interval
        GROUP BY sap_module
        HAVING count(*) >= 3`,
      [String(Math.max(1, daysBack))]
    );
    for (const r of hot) {
      const mod = r.sap_module || "AMS";
      // contar items PUBLISHED de ese módulo
      const { rows: pub } = await query<{ c: string }>(
        `SELECT count(*)::text AS c FROM kb_training_items
          WHERE module = $1 AND status = 'PUBLISHED'`,
        [mod]
      );
      const coverage = Number(pub[0]?.c ?? 0);
      if (coverage < 3) {
        const n = Number(r.n);
        out.push({
          signature: `low-coverage:${mod}`,
          title: `${mod} · módulo caliente con baja cobertura (${coverage} items publicados)`,
          description: `Hubo ${n} incidentes del módulo ${mod} en los últimos ${daysBack} días, pero solo ${coverage} artículos publicados en el corpus de entrenamiento. El agente probablemente no tiene contexto suficiente para responder.`,
          module: mod,
          process: processForModule(mod),
          priority: coverage === 0 ? "critical" : "high",
          suggestedAction: `Priorizar carga de conocimiento de ${mod}. Mínimo crear 3 artículos publicados: procedimiento estándar + error conocido más frecuente + FAQ con transacciones SAP típicas.`,
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, "gap-detector.coverage fail");
  }
  return out;
}

/**
 * Lee gaps actuales (OPEN o IN_PROGRESS) y arma un set de signatures
 * ya presentes para no duplicar.
 */
async function getExistingSignatures(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    // Guardamos la signature en title como prefijo "[sig:foo]". Buscamos eso.
    const { rows } = await query<{ title: string }>(
      `SELECT title FROM kb_training_gaps WHERE status IN ('OPEN','IN_PROGRESS')`
    );
    for (const r of rows) {
      const m = r.title.match(/^\[sig:([^\]]+)\]/);
      if (m) set.add(m[1]);
    }
  } catch (err) {
    logger.debug({ err }, "gap-detector.signatures fail");
  }
  return set;
}

export async function runGapDetection(daysBack = 14): Promise<GapDetectorReport> {
  // MT-2: cron sin contexto HTTP, usamos "default". TODO MT-6: parametrizar tenantId.
  const tenantId = "default";
  // Asegurar schema lazy de kb_training_*
  await training.getSnapshot(tenantId).catch(() => null);

  const [ticketsGaps, feedbackGaps, coverageGaps] = await Promise.all([
    detectTicketsWithoutKB(daysBack),
    detectNegativeFeedbackPatterns(daysBack),
    detectLowCoverageHotModules(daysBack),
  ]);

  const candidates = [...ticketsGaps, ...feedbackGaps, ...coverageGaps];
  const existingSigs = await getExistingSignatures();

  let created = 0, skipped = 0;
  for (const c of candidates) {
    if (existingSigs.has(c.signature)) {
      skipped++;
      continue;
    }
    try {
      // Prefijar el title con [sig:xxx] para idempotencia futura
      await training.createGap(tenantId, {
        title: `[sig:${c.signature}] ${c.title}`,
        description: c.description,
        module: c.module,
        process: c.process,
        priority: c.priority,
        suggestedAction: c.suggestedAction,
        status: "OPEN",
      });
      created++;
    } catch (err) {
      logger.warn({ err, sig: c.signature }, "gap-detector.create fail");
    }
  }

  const report: GapDetectorReport = {
    scannedAt: new Date().toISOString(),
    candidates: candidates.length,
    created,
    skipped,
    bySource: [
      { source: "tickets_without_kb", count: ticketsGaps.length },
      { source: "negative_feedback", count: feedbackGaps.length },
      { source: "low_coverage_hot_modules", count: coverageGaps.length },
    ],
  };
  logger.info(report, "gap-detector run");
  return report;
}
