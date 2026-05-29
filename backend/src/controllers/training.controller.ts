import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import * as training from "../services/training.service";
import type {
  KnowledgeStatus, KnowledgeType, Priority, ValidationStage,
  TrainingVersionStatus, GapStatus,
} from "../types/training.types";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============================================================
// SNAPSHOT (hidratacion inicial del frontend)
// ============================================================
export async function getSnapshot(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await training.getSnapshot();
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
    const items = await training.listItems({
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
    const row = await training.createItem({
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
    const row = await training.updateItem(id, {
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
    const ok = await training.deleteItem(id);
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
    const created = await training.createQA(items);
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
    const row = await training.updateQA(id, req.body || {});
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
    const ok = await training.deleteQA(id);
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
    const row = await training.createVersion({
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
    const row = await training.updateVersionStatus(id, s);
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
    const row = await training.createGap({
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
    const row = await training.updateGap(id, {
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
    const ok = await training.deleteGap(id);
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
export async function getSettings(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const s = await training.getSettings();
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
    const s = await training.updateSettings({
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
