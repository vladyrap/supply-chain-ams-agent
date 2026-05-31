// Controller compartido para Playbooks, Document Factory y Quality Evaluator.
// Cada módulo expone snapshot + upsert + delete + resetDemo.

import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import * as playbooks from "../services/playbooks.service";
import * as documents from "../services/documents.service";
import * as quality from "../services/quality-evaluator.service";

// ============================================================
// Playbooks
// ============================================================
export async function getPlaybooksSnapshot(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await playbooks.getSnapshot();
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "playbooks.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo playbooks" });
  }
}
export async function upsertPlaybook(req: FastifyRequest<{ Body: playbooks.AmsPlaybook }>, reply: FastifyReply) {
  try { return reply.send({ success: true, playbook: await playbooks.upsertPlaybook(req.body) }); }
  catch (err) { logger.error({ err }, "playbooks.upsert fail"); return reply.code(500).send({ success: false, error: "Error guardando playbook" }); }
}
export async function deletePlaybook(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await playbooks.deletePlaybook(req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "playbooks.delete fail"); return reply.code(500).send({ success: false, error: "Error eliminando playbook" }); }
}
export async function upsertExecution(req: FastifyRequest<{ Body: playbooks.PlaybookExecution }>, reply: FastifyReply) {
  try { return reply.send({ success: true, execution: await playbooks.upsertExecution(req.body) }); }
  catch (err) { logger.error({ err }, "playbooks.exec fail"); return reply.code(500).send({ success: false, error: "Error guardando ejecución" }); }
}
export async function deleteExecution(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await playbooks.deleteExecution(req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "playbooks.exec del fail"); return reply.code(500).send({ success: false, error: "Error eliminando ejecución" }); }
}
export async function resetPlaybooksDemo(_req: FastifyRequest, reply: FastifyReply) {
  try { await playbooks.resetDemo(); return reply.send({ success: true, ...(await playbooks.getSnapshot()) }); }
  catch (err) { logger.error({ err }, "playbooks.reset fail"); return reply.code(500).send({ success: false, error: "Error reset demo" }); }
}

// ============================================================
// Documents
// ============================================================
export async function getDocumentsSnapshot(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await documents.getSnapshot();
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "documents.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo documentos" });
  }
}
export async function upsertDocument(req: FastifyRequest<{ Body: documents.GeneratedDocument }>, reply: FastifyReply) {
  try { return reply.send({ success: true, document: await documents.upsertDocument(req.body) }); }
  catch (err) { logger.error({ err }, "documents.upsert fail"); return reply.code(500).send({ success: false, error: "Error guardando documento" }); }
}
export async function deleteDocument(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await documents.deleteDocument(req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "documents.delete fail"); return reply.code(500).send({ success: false, error: "Error eliminando documento" }); }
}
export async function resetDocumentsDemo(_req: FastifyRequest, reply: FastifyReply) {
  try { await documents.resetDemo(); return reply.send({ success: true, ...(await documents.getSnapshot()) }); }
  catch (err) { logger.error({ err }, "documents.reset fail"); return reply.code(500).send({ success: false, error: "Error reset demo" }); }
}

// ============================================================
// Quality Evaluator
// ============================================================
export async function getQualitySnapshot(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await quality.getSnapshot();
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "quality.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo evaluaciones" });
  }
}
export async function upsertEvaluation(req: FastifyRequest<{ Body: quality.AgentEvaluation }>, reply: FastifyReply) {
  try { return reply.send({ success: true, evaluation: await quality.upsertEvaluation(req.body) }); }
  catch (err) { logger.error({ err }, "quality.upsert fail"); return reply.code(500).send({ success: false, error: "Error guardando evaluación" }); }
}
export async function deleteEvaluation(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await quality.deleteEvaluation(req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "quality.delete fail"); return reply.code(500).send({ success: false, error: "Error eliminando evaluación" }); }
}
export async function resetQualityDemo(_req: FastifyRequest, reply: FastifyReply) {
  try { await quality.resetDemo(); return reply.send({ success: true, ...(await quality.getSnapshot()) }); }
  catch (err) { logger.error({ err }, "quality.reset fail"); return reply.code(500).send({ success: false, error: "Error reset demo" }); }
}
