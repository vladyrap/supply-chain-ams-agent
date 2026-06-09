import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import * as training from "../services/training.service";
import { runGapDetection } from "../services/gap-detector.service";
import {
  runQaEvaluation, listEvalRuns, getEvalRunDetail,
  runAbTest, autoPromoteIfBetter, diffEvalRuns,
} from "../services/qa-eval.service";
import { proposeQAsFromTickets } from "../services/ticket-to-qa.service";
import { autoGenerateQasForItems } from "../services/qa-auto-generator.service";
import { runSelfTrainingCycle } from "../services/self-training.service";
import { loadExpandedCorpus, CORPUS_SIZE } from "../services/training-demo-corpus";
import {
  getSelfTrainingConfig, updateSelfTrainingConfig, listSelfTrainingHistory,
  type UpdateConfigInput,
} from "../services/self-training-cron.service";
import { backfillTrainingEmbeddings } from "../services/training-embeddings.service";
import { getEvalTimeline } from "../services/eval-timeline.service";
import { runFeedbackPatternDetection } from "../services/feedback-patterns.service";
import { getReasoningTrace } from "../services/provenance.service";
import { getHallucinationReport, getWhitelistFromCorpus, invalidateWhitelist } from "../services/hallucination-detector.service";
import { getBorderlineQAs } from "../services/active-learning.service";
import type {
  KnowledgeStatus, KnowledgeType, Priority, ValidationStage,
  TrainingVersionStatus, GapStatus,
} from "../types/training.types";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// SNAPSHOT (hidratacion inicial del frontend)
// ============================================================
export async function getSnapshot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await training.getSnapshot(req.tenantId);
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "training.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo snapshot" });
  }
}

// ============================================================
// KNOWLEDGE ITEMS
// ============================================================
interface ListItemsQuery {
  status?: string; module?: string; type?: string; tag?: string;
  search?: string; minScore?: string; limit?: string;
}

export async function listItems(
  req: FastifyRequest<{ Querystring: ListItemsQuery }>,
  reply: FastifyReply
) {
  try {
    const q = req.query || {};
    const items = await training.listItems(req.tenantId, {
      status: q.status as KnowledgeStatus | undefined,
      module: q.module,
      type: q.type as KnowledgeType | undefined,
      tag: q.tag,
      search: q.search,
      minScore: q.minScore ? Number(q.minScore) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : 200,
    });
    return reply.send({ success: true, count: items.length, items });
  } catch (err) {
    logger.error({ err }, "training.listItems fail");
    return reply.code(500).send({ success: false, error: "Error listando items" });
  }
}

interface CreateItemBody {
  title?: string; content?: string; summary?: string;
  module?: string; process?: string; type?: string;
  source?: string; tags?: string[]; priority?: string; status?: string; author?: string;
}

export async function createItem(
  req: FastifyRequest<{ Body: CreateItemBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.title?.trim() || !b.content?.trim() || !b.module || !b.process || !b.type) {
    return reply.code(400).send({ success: false, error: "title, content, module, process, type son obligatorios" });
  }
  try {
    const row = await training.createItem(req.tenantId, {
      title: b.title.trim(),
      content: b.content,
      summary: (b.summary ?? b.content).slice(0, 500),
      module: b.module,
      process: b.process,
      type: b.type as KnowledgeType,
      source: b.source,
      tags: b.tags,
      priority: b.priority as Priority | undefined,
      status: b.status as KnowledgeStatus | undefined,
      author: b.author,
    });
    return reply.send({ success: true, item: row });
  } catch (err) {
    logger.error({ err }, "training.createItem fail");
    return reply.code(500).send({ success: false, error: "Error creando item" });
  }
}

interface UpdateItemBody {
  title?: string; content?: string; summary?: string;
  module?: string; process?: string; type?: string;
  source?: string; tags?: string[]; priority?: string; status?: string;
  score?: number; version?: string;
  validatedBy?: string | null;
  publishedAt?: string | null;
  validationStage?: string;
  functionalValidatedBy?: string | null;
  technicalValidatedBy?: string | null;
  rejectionReason?: string | null;
}

export async function updateItem(
  req: FastifyRequest<{ Params: { id: string }; Body: UpdateItemBody }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) return reply.code(400).send({ success: false, error: "ID inválido" });
  try {
    const b = req.body || {};
    const row = await training.updateItem(req.tenantId, id, {
      ...b,
      type: b.type as KnowledgeType | undefined,
      priority: b.priority as Priority | undefined,
      status: b.status as KnowledgeStatus | undefined,
      validationStage: b.validationStage as ValidationStage | undefined,
    });
    if (!row) return reply.code(404).send({ success: false, error: "Item no encontrado" });
    return reply.send({ success: true, item: row });
  } catch (err) {
    logger.error({ err, id }, "training.updateItem fail");
    return reply.code(500).send({ success: false, error: "Error actualizando item" });
  }
}

export async function deleteItem(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) return reply.code(400).send({ success: false, error: "ID inválido" });
  try {
    const ok = await training.deleteItem(req.tenantId, id);
    if (!ok) return reply.code(404).send({ success: false, error: "Item no encontrado" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err, id }, "training.deleteItem fail");
    return reply.code(500).send({ success: false, error: "Error eliminando item" });
  }
}

// ============================================================
// Q&A
// ============================================================
interface CreateQABody {
  items?: { knowledgeItemId?: string; question?: string; expectedAnswer?: string }[];
}

export async function createQA(
  req: FastifyRequest<{ Body: CreateQABody }>,
  reply: FastifyReply
) {
  const items = (req.body?.items ?? []).filter((it) =>
    it.knowledgeItemId && it.question && it.expectedAnswer
  ) as { knowledgeItemId: string; question: string; expectedAnswer: string }[];
  if (items.length === 0) {
    return reply.code(400).send({ success: false, error: "items vacío o invalido" });
  }
  try {
    const created = await training.createQA(req.tenantId, items);
    return reply.send({ success: true, qa: created });
  } catch (err) {
    logger.error({ err }, "training.createQA fail");
    return reply.code(500).send({ success: false, error: "Error creando Q&A" });
  }
}

export async function updateQA(
  req: FastifyRequest<{ Params: { id: string }; Body: { question?: string; expectedAnswer?: string; approved?: boolean } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) return reply.code(400).send({ success: false, error: "ID inválido" });
  try {
    const row = await training.updateQA(req.tenantId, id, req.body || {});
    if (!row) return reply.code(404).send({ success: false, error: "Q&A no encontrada" });
    return reply.send({ success: true, qa: row });
  } catch (err) {
    logger.error({ err, id }, "training.updateQA fail");
    return reply.code(500).send({ success: false, error: "Error actualizando Q&A" });
  }
}

export async function deleteQA(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) return reply.code(400).send({ success: false, error: "ID inválido" });
  try {
    const ok = await training.deleteQA(req.tenantId, id);
    if (!ok) return reply.code(404).send({ success: false, error: "Q&A no encontrada" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err, id }, "training.deleteQA fail");
    return reply.code(500).send({ success: false, error: "Error eliminando Q&A" });
  }
}

// ============================================================
// VERSIONS
// ============================================================
interface CreateVersionBody {
  version?: string; description?: string; createdBy?: string;
  itemCount?: number; validatedCount?: number; publishedCount?: number;
  changelog?: string[];
}

export async function createVersion(
  req: FastifyRequest<{ Body: CreateVersionBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.version?.trim()) return reply.code(400).send({ success: false, error: "version es obligatorio" });
  try {
    const row = await training.createVersion(req.tenantId, {
      version: b.version,
      description: b.description ?? "",
      createdBy: b.createdBy ?? "sistema",
      itemCount: b.itemCount ?? 0,
      validatedCount: b.validatedCount ?? 0,
      publishedCount: b.publishedCount ?? 0,
      changelog: b.changelog,
    });
    return reply.send({ success: true, version: row });
  } catch (err) {
    logger.error({ err }, "training.createVersion fail");
    return reply.code(500).send({ success: false, error: "Error creando versión" });
  }
}

export async function setVersionStatus(
  req: FastifyRequest<{ Params: { id: string }; Body: { status?: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) return reply.code(400).send({ success: false, error: "ID inválido" });
  const s = req.body?.status as TrainingVersionStatus | undefined;
  if (!s || !["DRAFT", "READY", "PUBLISHED", "ROLLED_BACK", "ARCHIVED"].includes(s)) {
    return reply.code(400).send({ success: false, error: "status inválido" });
  }
  try {
    const row = await training.updateVersionStatus(req.tenantId, id, s);
    if (!row) return reply.code(404).send({ success: false, error: "Versión no encontrada" });
    return reply.send({ success: true, version: row });
  } catch (err) {
    logger.error({ err, id }, "training.setVersionStatus fail");
    return reply.code(500).send({ success: false, error: "Error actualizando versión" });
  }
}

// ============================================================
// GAPS
// ============================================================
interface CreateGapBody {
  title?: string; description?: string; module?: string; process?: string;
  priority?: string; suggestedAction?: string; status?: string;
}

export async function createGap(
  req: FastifyRequest<{ Body: CreateGapBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.title?.trim() || !b.suggestedAction?.trim()) {
    return reply.code(400).send({ success: false, error: "title y suggestedAction son obligatorios" });
  }
  try {
    const row = await training.createGap(req.tenantId, {
      title: b.title,
      description: b.description ?? "",
      module: b.module ?? "AMS",
      process: b.process ?? "AMS Genérico",
      priority: (b.priority as Priority) ?? "medium",
      suggestedAction: b.suggestedAction,
      status: b.status as GapStatus | undefined,
    });
    return reply.send({ success: true, gap: row });
  } catch (err) {
    logger.error({ err }, "training.createGap fail");
    return reply.code(500).send({ success: false, error: "Error creando brecha" });
  }
}

export async function updateGap(
  req: FastifyRequest<{ Params: { id: string }; Body: CreateGapBody }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) return reply.code(400).send({ success: false, error: "ID inválido" });
  try {
    const b = req.body || {};
    const row = await training.updateGap(req.tenantId, id, {
      ...b,
      priority: b.priority as Priority | undefined,
      status: b.status as GapStatus | undefined,
    });
    if (!row) return reply.code(404).send({ success: false, error: "Brecha no encontrada" });
    return reply.send({ success: true, gap: row });
  } catch (err) {
    logger.error({ err, id }, "training.updateGap fail");
    return reply.code(500).send({ success: false, error: "Error actualizando brecha" });
  }
}

export async function deleteGap(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!UUID_RX.test(id)) return reply.code(400).send({ success: false, error: "ID inválido" });
  try {
    const ok = await training.deleteGap(req.tenantId, id);
    if (!ok) return reply.code(404).send({ success: false, error: "Brecha no encontrada" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err, id }, "training.deleteGap fail");
    return reply.code(500).send({ success: false, error: "Error eliminando brecha" });
  }
}

// ============================================================
// SETTINGS
// ============================================================
export async function getSettings(req: FastifyRequest, reply: FastifyReply) {
  try {
    const s = await training.getSettings(req.tenantId);
    return reply.send({ success: true, settings: s });
  } catch (err) {
    logger.error({ err }, "training.getSettings fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo settings" });
  }
}

export async function updateSettings(
  req: FastifyRequest<{ Body: Partial<{
    minScoreToPublish: number;
    requireFunctionalValidation: boolean;
    requireTechnicalValidation: boolean;
    allowAutoPublish: boolean;
    activeModules: string[];
    mainLanguage: string;
    responseFormat: string;
    versionRetention: number;
    strictMode: boolean;
  }> }>,
  reply: FastifyReply
) {
  try {
    const b = req.body || {};
    const s = await training.updateSettings(req.tenantId, {
      ...b,
      mainLanguage: b.mainLanguage as "es" | "en" | undefined,
      responseFormat: b.responseFormat as "concise" | "structured" | "narrative" | undefined,
    });
    return reply.send({ success: true, settings: s });
  } catch (err) {
    logger.error({ err }, "training.updateSettings fail");
    return reply.code(500).send({ success: false, error: "Error actualizando settings" });
  }
}

// ============================================================
// AUTO GAP DETECTION
// ============================================================
export async function postRunGapDetection(
  req: FastifyRequest<{ Body: { daysBack?: number } }>,
  reply: FastifyReply
) {
  const days = Math.max(1, Math.min(90, req.body?.daysBack ?? 14));
  try {
    const report = await runGapDetection(req.tenantId, days);
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "training.runGapDetection fail");
    return reply.code(500).send({ success: false, error: "Error ejecutando detección" });
  }
}

// ============================================================
// QA EVALUATION
// ============================================================
export async function postRunQaEval(
  req: FastifyRequest<{ Body: { limit?: number; triggeredBy?: string } }>,
  reply: FastifyReply
) {
  const limit = req.body?.limit;
  try {
    const report = await runQaEvaluation(req.tenantId, { limit, triggeredBy: req.body?.triggeredBy });
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "training.runQaEval fail");
    const msg = err instanceof Error ? err.message : "Error ejecutando evaluación";
    return reply.code(500).send({ success: false, error: msg });
  }
}

export async function getEvalRunsList(req: FastifyRequest, reply: FastifyReply) {
  try {
    const runs = await listEvalRuns(req.tenantId, 30);
    return reply.send({ success: true, count: runs.length, runs });
  } catch (err) {
    logger.error({ err }, "training.listEvalRuns fail");
    return reply.code(500).send({ success: false, error: "Error listando runs" });
  }
}

export async function getEvalRunDetailRoute(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  try {
    const detail = await getEvalRunDetail(req.tenantId, id);
    if (!detail) return reply.code(404).send({ success: false, error: "Run no encontrado" });
    return reply.send({ success: true, run: detail });
  } catch (err) {
    logger.error({ err, id }, "training.getEvalRunDetail fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo detalle" });
  }
}

// ============================================================
// A/B TEST + AUTO-PROMOTE
// ============================================================
interface AbBody {
  promptA?: { systemPrompt: string; label: string };
  promptB?: { systemPrompt: string; label: string };
  limit?: number;
}
export async function postAbTest(
  req: FastifyRequest<{ Body: AbBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.promptB?.systemPrompt?.trim() || !b.promptB?.label?.trim()) {
    return reply.code(400).send({ success: false, error: "promptB.systemPrompt y promptB.label son obligatorios" });
  }
  try {
    const report = await runAbTest(req.tenantId, {
      promptA: b.promptA,
      promptB: b.promptB,
      limit: b.limit,
    });
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "training.abTest fail");
    return reply.code(500).send({ success: false, error: "Error ejecutando A/B" });
  }
}

interface AutoPromoteBody {
  candidate?: { systemPrompt: string; label: string; temperature?: number; maxTokens?: number };
  minDelta?: number;
  limit?: number;
  apply?: boolean;
}
export async function postAutoPromote(
  req: FastifyRequest<{ Body: AutoPromoteBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.candidate?.systemPrompt?.trim() || !b.candidate?.label?.trim()) {
    return reply.code(400).send({ success: false, error: "candidate.systemPrompt y candidate.label son obligatorios" });
  }
  try {
    const result = await autoPromoteIfBetter(req.tenantId, {
      candidate: b.candidate,
      minDelta: b.minDelta,
      limit: b.limit,
      apply: b.apply ?? false,
    });
    return reply.send({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "training.autoPromote fail");
    return reply.code(500).send({ success: false, error: "Error en auto-promote" });
  }
}

// ============================================================
// COMPARADOR de runs
// ============================================================
export async function getEvalDiff(
  req: FastifyRequest<{ Querystring: { a?: string; b?: string } }>,
  reply: FastifyReply
) {
  const { a, b } = req.query;
  if (!a || !b) return reply.code(400).send({ success: false, error: "a y b son obligatorios" });
  try {
    const diff = await diffEvalRuns(req.tenantId, a, b);
    if (!diff) return reply.code(404).send({ success: false, error: "Run(s) no encontrado(s)" });
    return reply.send({ success: true, diff });
  } catch (err) {
    logger.error({ err }, "training.diffEvalRuns fail");
    return reply.code(500).send({ success: false, error: "Error comparando runs" });
  }
}

// ============================================================
// TICKETS -> Q&A
// ============================================================
export async function postProposeQasFromTickets(
  req: FastifyRequest<{ Body: { limit?: number; daysBack?: number } }>,
  reply: FastifyReply
) {
  try {
    const report = await proposeQAsFromTickets(req.tenantId, {
      limit: req.body?.limit,
      daysBack: req.body?.daysBack,
    });
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "training.proposeQasFromTickets fail");
    const msg = err instanceof Error ? err.message : "Error proponiendo Q&A";
    return reply.code(500).send({ success: false, error: msg });
  }
}

// ============================================================
// AUTO-Q&A GENERATOR
// ============================================================
export async function postAutoGenerateQas(
  req: FastifyRequest<{ Body: { limit?: number } }>,
  reply: FastifyReply
) {
  try {
    const report = await autoGenerateQasForItems(req.tenantId, { limit: req.body?.limit });
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "training.autoGenerateQas fail");
    return reply.code(500).send({ success: false, error: "Error generando Q&A" });
  }
}

// ============================================================
// SELF-TRAINING ORCHESTRATOR
// ============================================================
interface SelfTrainingBody {
  evalLimit?: number;
  ticketsLimit?: number;
  autoApproveLimit?: number;
  autoApproveMinScore?: number;
  runEval?: boolean;
}
export async function postSelfTrainingRun(
  req: FastifyRequest<{ Body: SelfTrainingBody }>,
  reply: FastifyReply
) {
  try {
    const report = await runSelfTrainingCycle(req.tenantId, req.body || {});
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "training.selfTraining fail");
    return reply.code(500).send({ success: false, error: "Error en self-training" });
  }
}

// ============================================================
// EXPANDED CORPUS LOADER
// ============================================================
export async function postLoadExpandedCorpus(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const result = await loadExpandedCorpus();
    return reply.send({ success: true, ...result, corpusSize: CORPUS_SIZE });
  } catch (err) {
    logger.error({ err }, "training.loadExpandedCorpus fail");
    return reply.code(500).send({ success: false, error: "Error cargando corpus" });
  }
}

// ============================================================
// SELF-TRAINING CRON CONFIG + HISTORIAL
// ============================================================
export async function getSelfTrainingConfigRoute(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const cfg = await getSelfTrainingConfig();
    return reply.send({ success: true, config: cfg });
  } catch (err) {
    logger.error({ err }, "selfTraining.getConfig fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo config" });
  }
}

export async function patchSelfTrainingConfigRoute(
  req: FastifyRequest<{ Body: UpdateConfigInput }>,
  reply: FastifyReply
) {
  try {
    const cfg = await updateSelfTrainingConfig(req.body || {});
    return reply.send({ success: true, config: cfg });
  } catch (err) {
    logger.error({ err }, "selfTraining.patchConfig fail");
    return reply.code(500).send({ success: false, error: "Error actualizando config" });
  }
}

export async function getSelfTrainingHistoryRoute(req: FastifyRequest, reply: FastifyReply) {
  try {
    const runs = await listSelfTrainingHistory(req.tenantId, 30);
    return reply.send({ success: true, count: runs.length, runs });
  } catch (err) {
    logger.error({ err }, "selfTraining.history fail");
    return reply.code(500).send({ success: false, error: "Error listando historial" });
  }
}

// ============================================================
// EMBEDDINGS BACKFILL
// ============================================================
export async function postBackfillEmbeddings(
  req: FastifyRequest<{ Body: { limit?: number } }>,
  reply: FastifyReply
) {
  try {
    const report = await backfillTrainingEmbeddings(req.tenantId, { limit: req.body?.limit });
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "embeddings.backfill fail");
    return reply.code(500).send({ success: false, error: "Error en backfill embeddings" });
  }
}

// ============================================================
// TIMELINE + DRIFT
// ============================================================
export async function getEvalTimelineRoute(
  req: FastifyRequest<{ Querystring: { days?: string; threshold?: string } }>,
  reply: FastifyReply
) {
  const days = req.query?.days ? parseInt(req.query.days, 10) : 30;
  const threshold = req.query?.threshold ? parseInt(req.query.threshold, 10) : 10;
  try {
    const data = await getEvalTimeline(req.tenantId, days, threshold);
    return reply.send({ success: true, ...data });
  } catch (err) {
    logger.error({ err }, "eval.timeline fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo timeline" });
  }
}

// ============================================================
// FEEDBACK PATTERNS
// ============================================================
export async function postFeedbackPatterns(
  req: FastifyRequest<{ Body: { daysBack?: number; minClusterSize?: number } }>,
  reply: FastifyReply
) {
  try {
    const report = await runFeedbackPatternDetection(req.tenantId, {
      daysBack: req.body?.daysBack,
      minClusterSize: req.body?.minClusterSize,
    });
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "feedback-patterns fail");
    const msg = err instanceof Error ? err.message : "Error detectando patrones";
    return reply.code(500).send({ success: false, error: msg });
  }
}

// ============================================================
// REASONING TRACE
// ============================================================
export async function getReasoningTraceRoute(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  try {
    const trace = await getReasoningTrace(req.tenantId, id);
    if (!trace) return reply.code(404).send({ success: false, error: "Trace no encontrado" });
    return reply.send({ success: true, trace });
  } catch (err) {
    logger.error({ err, id }, "reasoning-trace fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo trace" });
  }
}

// ============================================================
// HALLUCINATION REPORT + WHITELIST
// ============================================================
export async function getHallucinationReportRoute(req: FastifyRequest, reply: FastifyReply) {
  try {
    const report = await getHallucinationReport(req.tenantId);
    return reply.send({ success: true, report });
  } catch (err) {
    logger.error({ err }, "hallucination-report fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo reporte" });
  }
}

export async function getHallucinationWhitelist(req: FastifyRequest, reply: FastifyReply) {
  try {
    const w = await getWhitelistFromCorpus(req.tenantId);
    return reply.send({ success: true, count: w.size, transactions: Array.from(w).sort() });
  } catch (err) {
    logger.error({ err }, "whitelist fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo whitelist" });
  }
}

export async function postInvalidateWhitelist(_req: FastifyRequest, reply: FastifyReply) {
  invalidateWhitelist();
  return reply.send({ success: true, message: "Whitelist invalidada — se reconstruirá en la próxima consulta" });
}

// ============================================================
// ACTIVE LEARNING · Q&A borderline
// ============================================================
export async function getBorderlineQAsRoute(
  req: FastifyRequest<{ Querystring: { limit?: string } }>,
  reply: FastifyReply
) {
  try {
    const limit = req.query?.limit ? parseInt(req.query.limit, 10) : 30;
    const report = await getBorderlineQAs(req.tenantId, { limit });
    return reply.send({ success: true, ...report });
  } catch (err) {
    logger.error({ err }, "borderline QAs fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo Q&A borderline" });
  }
}
