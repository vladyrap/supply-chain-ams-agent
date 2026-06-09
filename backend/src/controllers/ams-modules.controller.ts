// Controller compartido para Playbooks, Document Factory y Quality Evaluator.
// Cada módulo expone snapshot + upsert + delete + resetDemo.
// Multi-tenant: pasamos req.tenantId al service (Sprint 3 ALTOS).

import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import * as playbooks from "../services/playbooks.service";
import * as documents from "../services/documents.service";
import * as quality from "../services/quality-evaluator.service";

// ============================================================
// Playbooks
// ============================================================
export async function getPlaybooksSnapshot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await playbooks.getSnapshot(req.tenantId);
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "playbooks.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo playbooks" });
  }
}
export async function upsertPlaybook(req: FastifyRequest<{ Body: playbooks.AmsPlaybook }>, reply: FastifyReply) {
  try { return reply.send({ success: true, playbook: await playbooks.upsertPlaybook(req.tenantId, req.body) }); }
  catch (err) { logger.error({ err }, "playbooks.upsert fail"); return reply.code(500).send({ success: false, error: "Error guardando playbook" }); }
}
export async function deletePlaybook(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await playbooks.deletePlaybook(req.tenantId, req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "playbooks.delete fail"); return reply.code(500).send({ success: false, error: "Error eliminando playbook" }); }
}
export async function upsertExecution(req: FastifyRequest<{ Body: playbooks.PlaybookExecution }>, reply: FastifyReply) {
  try { return reply.send({ success: true, execution: await playbooks.upsertExecution(req.tenantId, req.body) }); }
  catch (err) { logger.error({ err }, "playbooks.exec fail"); return reply.code(500).send({ success: false, error: "Error guardando ejecución" }); }
}
export async function deleteExecution(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await playbooks.deleteExecution(req.tenantId, req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "playbooks.exec del fail"); return reply.code(500).send({ success: false, error: "Error eliminando ejecución" }); }
}
export async function resetPlaybooksDemo(req: FastifyRequest, reply: FastifyReply) {
  try { await playbooks.resetDemo(req.tenantId); return reply.send({ success: true, ...(await playbooks.getSnapshot(req.tenantId)) }); }
  catch (err) { logger.error({ err }, "playbooks.reset fail"); return reply.code(500).send({ success: false, error: "Error reset demo" }); }
}

// ============================================================
// Documents
// ============================================================
export async function getDocumentsSnapshot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await documents.getSnapshot(req.tenantId);
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "documents.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo documentos" });
  }
}
export async function upsertDocument(req: FastifyRequest<{ Body: documents.GeneratedDocument }>, reply: FastifyReply) {
  try { return reply.send({ success: true, document: await documents.upsertDocument(req.tenantId, req.body) }); }
  catch (err) { logger.error({ err }, "documents.upsert fail"); return reply.code(500).send({ success: false, error: "Error guardando documento" }); }
}
export async function deleteDocument(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await documents.deleteDocument(req.tenantId, req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "documents.delete fail"); return reply.code(500).send({ success: false, error: "Error eliminando documento" }); }
}
export async function resetDocumentsDemo(req: FastifyRequest, reply: FastifyReply) {
  try { await documents.resetDemo(req.tenantId); return reply.send({ success: true, ...(await documents.getSnapshot(req.tenantId)) }); }
  catch (err) { logger.error({ err }, "documents.reset fail"); return reply.code(500).send({ success: false, error: "Error reset demo" }); }
}

// ============================================================
// Quality Evaluator (MT-3 ALTOS)
// ============================================================
export async function getQualitySnapshot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await quality.getSnapshot(req.tenantId);
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "quality.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo evaluaciones" });
  }
}
export async function upsertEvaluation(req: FastifyRequest<{ Body: quality.AgentEvaluation }>, reply: FastifyReply) {
  try { return reply.send({ success: true, evaluation: await quality.upsertEvaluation(req.tenantId, req.body) }); }
  catch (err) { logger.error({ err }, "quality.upsert fail"); return reply.code(500).send({ success: false, error: "Error guardando evaluación" }); }
}
export async function deleteEvaluation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await quality.deleteEvaluation(req.tenantId, req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "quality.delete fail"); return reply.code(500).send({ success: false, error: "Error eliminando evaluación" }); }
}
export async function resetQualityDemo(req: FastifyRequest, reply: FastifyReply) {
  try { await quality.resetDemo(req.tenantId); return reply.send({ success: true, ...(await quality.getSnapshot(req.tenantId)) }); }
  catch (err) { logger.error({ err }, "quality.reset fail"); return reply.code(500).send({ success: false, error: "Error reset demo" }); }
}
