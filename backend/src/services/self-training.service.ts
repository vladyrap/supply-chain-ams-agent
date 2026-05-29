// Self-training orchestrator.
//
// Un único endpoint que ejecuta el ciclo completo de pulido del agente:
//
//   1) Detectar brechas (tickets sin KB, feedback negativo, low coverage)
//   2) Generar Q&A propuestas a partir de tickets cerrados
//   3) Auto-aprobar Q&A pending de alta calidad (juez Gemini score ≥ X)
//   4) Auto-generar Q&A para items publicados sin Q&A (refuerzo few-shot)
//   5) Correr evaluación contra el agente activo
//   6) Reportar métricas before/after
//
// Pensado para ser ejecutado on-demand desde UI o por cron futuro.

import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { ConfigError } from "../utils/errors";
import { runGapDetection, type GapDetectorReport } from "./gap-detector.service";
import { proposeQAsFromTickets, type TicketToQaReport } from "./ticket-to-qa.service";
import { autoGenerateQasForItems, type AutoQaReport } from "./qa-auto-generator.service";
import { runQaEvaluation, type EvalRunReport } from "./qa-eval.service";

const MODEL = "gemini-2.5-flash";

let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ConfigError("GEMINI_API_KEY no configurada");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

export type StageStatus = "ok" | "skipped" | "error";

export interface StageResult {
  name: string;
  status: StageStatus;
  durationMs: number;
  detail: string;
  data?: unknown;
}

export interface SelfTrainingReport {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  stages: StageResult[];
  before: {
    itemsTotal: number;
    itemsPublished: number;
    qasTotal: number;
    qasApproved: number;
    openGaps: number;
  };
  after: {
    itemsTotal: number;
    itemsPublished: number;
    qasTotal: number;
    qasApproved: number;
    openGaps: number;
    evalAvgScore: number | null;
    evalPassRate: number | null;
  };
}

async function snapshot(): Promise<SelfTrainingReport["before"]> {
  const out = {
    itemsTotal: 0, itemsPublished: 0, qasTotal: 0, qasApproved: 0, openGaps: 0,
  };
  try {
    const { rows } = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM kb_training_items`
    );
    out.itemsTotal = Number(rows[0]?.c ?? 0);
  } catch { /* tablas aún no existen */ }
  try {
    const { rows } = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM kb_training_items WHERE status = 'PUBLISHED'`
    );
    out.itemsPublished = Number(rows[0]?.c ?? 0);
  } catch { /* */ }
  try {
    const { rows } = await query<{ c: string }>(`SELECT count(*)::text AS c FROM kb_training_qa`);
    out.qasTotal = Number(rows[0]?.c ?? 0);
  } catch { /* */ }
  try {
    const { rows } = await query<{ c: string }>(`SELECT count(*)::text AS c FROM kb_training_qa WHERE approved = true`);
    out.qasApproved = Number(rows[0]?.c ?? 0);
  } catch { /* */ }
  try {
    const { rows } = await query<{ c: string }>(`SELECT count(*)::text AS c FROM kb_training_gaps WHERE status IN ('OPEN','IN_PROGRESS')`);
    out.openGaps = Number(rows[0]?.c ?? 0);
  } catch { /* */ }
  return out;
}

interface JudgeOut {
  score?: number;
  approve?: boolean;
}

/**
 * Auto-aprobar Q&A pending de alta calidad usando Gemini como juez.
 * Score >= minScore → approved=true. Caro en quota — limit chico.
 */
async function autoApproveHighQualityQAs(maxToReview: number, minScore: number): Promise<{
  reviewed: number; approved: number; skipped: number;
}> {
  const out = { reviewed: 0, approved: 0, skipped: 0 };
  if (maxToReview <= 0) return out;

  let pending: { id: string; question: string; expected_answer: string; item_module: string | null }[] = [];
  try {
    const { rows } = await query<{
      id: string; question: string; expected_answer: string;
      item_module: string | null;
    }>(
      `SELECT q.id, q.question, q.expected_answer, i.module AS item_module
         FROM kb_training_qa q
         LEFT JOIN kb_training_items i ON i.id = q.knowledge_item_id
        WHERE q.approved = false
          AND (i.status IS NULL OR i.status NOT IN ('ARCHIVED','REJECTED'))
        ORDER BY q.created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(20, maxToReview))]
    );
    pending = rows;
  } catch (err) {
    logger.debug({ err }, "autoApprove: query pending fail");
    return out;
  }

  if (pending.length === 0) return out;
  const ai = getClient();
  for (const qa of pending) {
    out.reviewed++;
    const prompt = `Evaluá si esta Q&A está lista para usarse como entrenamiento de un agente AMS Supply Chain SAP.

Módulo: ${qa.item_module ?? "AMS"}
Pregunta: ${qa.question}
Respuesta esperada: ${qa.expected_answer}

Criterios para aprobar (todos):
- La respuesta es técnicamente correcta y específica.
- Menciona transacciones SAP, tablas o pasos accionables (no genérica).
- No tiene errores evidentes ni alucinaciones.
- Es accionable para un consultor AMS junior.

Devolvé SOLO JSON sin markdown:
{ "score": 0-100, "approve": true|false }

Regla: approve = true solo si score >= ${minScore}.`;

    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          systemInstruction: "Sos un revisor estricto de contenido AMS. Respondés SOLO JSON.",
          responseMimeType: "application/json",
          maxOutputTokens: 128,
          temperature: 0.1,
        },
      });
      const text = (resp.text ?? "").trim();
      let parsed: JudgeOut = {};
      try { parsed = JSON.parse(text); }
      catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch { /* */ } }
      }
      const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
      const approve = parsed.approve === true && score >= minScore;
      if (approve) {
        await query(`UPDATE kb_training_qa SET approved = true WHERE id = $1`, [qa.id]);
        out.approved++;
      } else {
        out.skipped++;
      }
    } catch (err) {
      logger.debug({ err, qaId: qa.id }, "autoApprove judge fail");
      out.skipped++;
    }
  }
  return out;
}

export interface SelfTrainingInput {
  evalLimit?: number;
  ticketsLimit?: number;
  autoApproveLimit?: number;
  autoApproveMinScore?: number;
  /** Si false, no corre eval (más rápido) */
  runEval?: boolean;
}

export async function runSelfTrainingCycle(input: SelfTrainingInput = {}): Promise<SelfTrainingReport> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const stages: StageResult[] = [];

  const before = await snapshot();

  async function stage<T>(name: string, fn: () => Promise<{ detail: string; data?: T }>): Promise<void> {
    const t0 = Date.now();
    try {
      const r = await fn();
      stages.push({ name, status: "ok", durationMs: Date.now() - t0, detail: r.detail, data: r.data });
    } catch (err) {
      stages.push({
        name,
        status: "error",
        durationMs: Date.now() - t0,
        detail: err instanceof Error ? err.message : "error desconocido",
      });
      logger.warn({ err, stage: name }, "self-training stage fail");
    }
  }

  // 1. Detect gaps
  await stage<GapDetectorReport>("Detectar brechas", async () => {
    const report = await runGapDetection(14);
    return {
      detail: `${report.candidates} candidatos · ${report.created} nuevos creados · ${report.skipped} ya existían`,
      data: report,
    };
  });

  // 2. Propose Q&A desde tickets recientes
  await stage<TicketToQaReport>("Tickets → Q&A propuestas", async () => {
    const report = await proposeQAsFromTickets({ limit: input.ticketsLimit ?? 3, daysBack: 30 });
    return {
      detail: `${report.ticketsScanned} tickets analizados · ${report.itemsCreated} items DRAFT · ${report.qasProposed} Q&A pending`,
      data: report,
    };
  });

  // 3. Auto-aprobar Q&A pending de alta calidad
  await stage("Auto-aprobar Q&A (juez Gemini)", async () => {
    const r = await autoApproveHighQualityQAs(input.autoApproveLimit ?? 6, input.autoApproveMinScore ?? 80);
    return {
      detail: `${r.reviewed} revisadas · ${r.approved} aprobadas · ${r.skipped} para revisión humana`,
      data: r,
    };
  });

  // 4. Auto-generar Q&A para items publicados sin Q&A
  await stage<AutoQaReport>("Auto-Q&A para items sin Q&A", async () => {
    const r = await autoGenerateQasForItems({ limit: 20 });
    return {
      detail: `${r.itemsScanned} items procesados · ${r.qasCreated} Q&A generadas · ${r.qasApproved} aprobadas auto`,
      data: r,
    };
  });

  // 5. Evaluación (opcional)
  let evalReport: EvalRunReport | null = null;
  if (input.runEval !== false) {
    await stage<EvalRunReport>("Evaluación contra agente activo", async () => {
      evalReport = await runQaEvaluation({ limit: input.evalLimit ?? 10, triggeredBy: "self-training" });
      const passRate = evalReport.totalQas > 0
        ? Math.round((evalReport.passed / evalReport.totalQas) * 100)
        : 0;
      return {
        detail: `${evalReport.totalQas} Q&A evaluadas · score promedio ${evalReport.avgScore} · ${passRate}% pass`,
        data: evalReport,
      };
    });
  } else {
    stages.push({
      name: "Evaluación contra agente activo",
      status: "skipped", durationMs: 0,
      detail: "skipped por el caller (runEval: false)",
    });
  }

  const afterSnap = await snapshot();
  const after: SelfTrainingReport["after"] = {
    ...afterSnap,
    evalAvgScore: evalReport ? (evalReport as EvalRunReport).avgScore : null,
    evalPassRate: evalReport && (evalReport as EvalRunReport).totalQas > 0
      ? Math.round(((evalReport as EvalRunReport).passed / (evalReport as EvalRunReport).totalQas) * 100)
      : null,
  };

  const finishedAt = new Date().toISOString();
  const totalMs = Date.now() - start;

  const report: SelfTrainingReport = {
    startedAt, finishedAt, totalMs, stages, before, after,
  };
  logger.info({ ...report, stages: stages.length }, "self-training cycle completed");
  return report;
}
