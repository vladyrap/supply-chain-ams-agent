import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import * as svc from "../services/testing.service";
import {
  exportTestCaseToCloudAlm, cloudAlmStatus, type CloudAlmTestCasePayload,
} from "../services/cloud-alm.service";
import { analyzeVideoEvidence } from "../services/testing-video-analysis.service";

// ============================================================
// Snapshot
// ============================================================
export async function getSnapshot(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await svc.getSnapshot();
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "testing.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo snapshot de testing" });
  }
}

// ============================================================
// Scenarios
// ============================================================
export async function upsertScenario(req: FastifyRequest<{ Body: svc.TestingScenario }>, reply: FastifyReply) {
  try {
    const s = await svc.upsertScenario(req.body);
    return reply.send({ success: true, scenario: s });
  } catch (err) {
    logger.error({ err }, "testing.upsertScenario fail");
    return reply.code(500).send({ success: false, error: "Error guardando escenario" });
  }
}

export async function deleteScenario(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    await svc.deleteScenario(req.params.id);
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "testing.deleteScenario fail");
    return reply.code(500).send({ success: false, error: "Error eliminando escenario" });
  }
}

// ============================================================
// Evidences — JSON (notes, links, logs sin binario)
// ============================================================
export async function createEvidenceJson(req: FastifyRequest<{ Body: svc.EvidenceItem }>, reply: FastifyReply) {
  try {
    const e = await svc.createEvidence(req.body);
    return reply.send({ success: true, evidence: e });
  } catch (err) {
    logger.error({ err }, "testing.createEvidence(json) fail");
    return reply.code(500).send({ success: false, error: "Error creando evidencia" });
  }
}

export async function deleteEvidence(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    await svc.deleteEvidence(req.params.id);
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "testing.deleteEvidence fail");
    return reply.code(500).send({ success: false, error: "Error eliminando evidencia" });
  }
}

// ============================================================
// Evidence file upload (multipart)
// POST /api/testing/evidences/upload
// fields: scenarioId, type, title, description?, durationSeconds?, tags? (csv), createdBy
// file:   file
// ============================================================
export async function uploadEvidence(req: FastifyRequest, reply: FastifyReply) {
  try {
    const data = await req.file();
    if (!data) return reply.code(400).send({ success: false, error: "No se recibió archivo" });

    const fields = (data.fields || {}) as Record<string, { value?: string } | undefined>;
    const scenarioId = fields.scenarioId?.value || "";
    const evType = (fields.type?.value as svc.EvidenceType) || "UPLOADED_VIDEO";
    const title = fields.title?.value || data.filename || "Evidencia";
    const description = fields.description?.value;
    const durationSeconds = fields.durationSeconds?.value ? Number(fields.durationSeconds.value) : undefined;
    const tagsCsv = fields.tags?.value || "";
    const tags = tagsCsv ? tagsCsv.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const createdBy = fields.createdBy?.value || "demo@user";

    if (!scenarioId) {
      return reply.code(400).send({ success: false, error: "scenarioId requerido" });
    }

    // Lee el stream completo a memoria. Límite seteado por Fastify (default ~50MB).
    const buffer = await data.toBuffer();

    const storagePath = await svc.saveUploadedFile(scenarioId, data.filename || "evidence.bin", buffer);

    const evidence: svc.EvidenceItem = {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      scenarioId,
      type: evType,
      title,
      description,
      fileName: data.filename,
      fileType: data.mimetype,
      fileSize: buffer.length,
      durationSeconds,
      storagePath,
      tags,
      createdAt: new Date().toISOString(),
      createdBy,
    };
    const saved = await svc.createEvidence(evidence);
    return reply.send({ success: true, evidence: saved });
  } catch (err) {
    logger.error({ err }, "testing.uploadEvidence fail");
    return reply.code(500).send({ success: false, error: "Error subiendo archivo" });
  }
}

// GET /api/testing/evidences/:id/file
export async function getEvidenceFile(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    const ev = await svc.getEvidence(req.params.id);
    if (!ev) return reply.code(404).send({ success: false, error: "Evidencia no encontrada" });
    if (!ev.storagePath) return reply.code(404).send({ success: false, error: "Esta evidencia no tiene archivo asociado" });
    const buffer = await svc.readEvidenceFile(ev.storagePath);
    reply.header("Content-Type", ev.fileType || "application/octet-stream");
    reply.header("Content-Length", String(buffer.length));
    reply.header("Content-Disposition", `inline; filename="${(ev.fileName || "evidence").replace(/"/g, "")}"`);
    return reply.send(buffer);
  } catch (err) {
    logger.error({ err }, "testing.getEvidenceFile fail");
    return reply.code(500).send({ success: false, error: "Error leyendo archivo" });
  }
}

// ============================================================
// Defects
// ============================================================
export async function upsertDefect(req: FastifyRequest<{ Body: svc.TestDefect }>, reply: FastifyReply) {
  try {
    const d = await svc.upsertDefect(req.body);
    return reply.send({ success: true, defect: d });
  } catch (err) {
    logger.error({ err }, "testing.upsertDefect fail");
    return reply.code(500).send({ success: false, error: "Error guardando defecto" });
  }
}

export async function deleteDefect(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    await svc.deleteDefect(req.params.id);
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "testing.deleteDefect fail");
    return reply.code(500).send({ success: false, error: "Error eliminando defecto" });
  }
}

// ============================================================
// Manuals
// ============================================================
export async function upsertManual(req: FastifyRequest<{ Body: svc.GeneratedUserManual }>, reply: FastifyReply) {
  try {
    const m = await svc.upsertManual(req.body);
    return reply.send({ success: true, manual: m });
  } catch (err) {
    logger.error({ err }, "testing.upsertManual fail");
    return reply.code(500).send({ success: false, error: "Error guardando manual" });
  }
}

// ============================================================
// Settings + reset
// ============================================================
export async function updateSettings(req: FastifyRequest<{ Body: Partial<svc.TestingSettings> }>, reply: FastifyReply) {
  try {
    const s = await svc.updateSettings(req.body);
    return reply.send({ success: true, settings: s });
  } catch (err) {
    logger.error({ err }, "testing.updateSettings fail");
    return reply.code(500).send({ success: false, error: "Error actualizando configuración" });
  }
}

export async function postResetDemo(_req: FastifyRequest, reply: FastifyReply) {
  try {
    await svc.resetDemo();
    const snap = await svc.getSnapshot();
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "testing.resetDemo fail");
    return reply.code(500).send({ success: false, error: "Error reseteando datos demo" });
  }
}

// ============================================================
// Cloud ALM
// ============================================================
export async function getCloudAlmStatus(_req: FastifyRequest, reply: FastifyReply) {
  try { return reply.send({ success: true, status: cloudAlmStatus() }); }
  catch (err) { logger.error({ err }, "testing.cloudAlmStatus fail"); return reply.code(500).send({ success: false, error: "Error" }); }
}

export async function postCloudAlmExport(
  req: FastifyRequest<{ Body: { payload: CloudAlmTestCasePayload; confirmReal?: boolean } }>,
  reply: FastifyReply
) {
  try {
    const { payload, confirmReal } = req.body || ({} as { payload?: CloudAlmTestCasePayload; confirmReal?: boolean });
    if (!payload) return reply.code(400).send({ success: false, error: "payload requerido" });
    const result = await exportTestCaseToCloudAlm(payload, { confirmReal });
    return reply.send({ success: true, result });
  } catch (err) {
    logger.error({ err }, "testing.cloudAlmExport fail");
    return reply.code(500).send({ success: false, error: "Error exportando a Cloud ALM" });
  }
}

// ============================================================
// Análisis IA de video (Whisper + Gemini)
// POST /api/testing/evidences/:id/analyze
// ============================================================
export async function postAnalyzeVideo(
  req: FastifyRequest<{ Params: { id: string }; Body?: { language?: string } }>,
  reply: FastifyReply
) {
  try {
    const language = req.body?.language || "es";
    const result = await analyzeVideoEvidence(req.params.id, language);
    return reply.send({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "testing.analyzeVideo fail");
    return reply.code(500).send({
      success: false,
      error: err instanceof Error ? err.message : "Error analizando video",
    });
  }
}
