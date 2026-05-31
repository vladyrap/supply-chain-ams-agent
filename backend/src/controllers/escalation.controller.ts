import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import * as svc from "../services/escalation.service";

// ============================================================
// Snapshot
// ============================================================
export async function getSnapshot(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await svc.getSnapshot();
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "escalation.snapshot fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo snapshot de escalamiento" });
  }
}

// ============================================================
// Rules
// ============================================================
export async function upsertRule(req: FastifyRequest<{ Body: svc.EscalationRule }>, reply: FastifyReply) {
  try {
    const r = await svc.upsertRule(req.body);
    return reply.send({ success: true, rule: r });
  } catch (err) {
    logger.error({ err }, "escalation.upsertRule fail");
    return reply.code(500).send({ success: false, error: "Error guardando regla" });
  }
}
export async function deleteRule(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    await svc.deleteRule(req.params.id);
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "escalation.deleteRule fail");
    return reply.code(500).send({ success: false, error: "Error eliminando regla" });
  }
}

// ============================================================
// Responsibles
// ============================================================
export async function upsertResponsible(req: FastifyRequest<{ Body: svc.N2Responsible }>, reply: FastifyReply) {
  try {
    const r = await svc.upsertResponsible(req.body);
    return reply.send({ success: true, responsible: r });
  } catch (err) {
    logger.error({ err }, "escalation.upsertResponsible fail");
    return reply.code(500).send({ success: false, error: "Error guardando responsable" });
  }
}
export async function deleteResponsible(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    await svc.deleteResponsible(req.params.id);
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "escalation.deleteResponsible fail");
    return reply.code(500).send({ success: false, error: "Error eliminando responsable" });
  }
}

// ============================================================
// Records
// ============================================================
export async function createRecord(req: FastifyRequest<{ Body: svc.EscalationRecord }>, reply: FastifyReply) {
  try {
    const r = await svc.createRecord(req.body);
    return reply.send({ success: true, record: r });
  } catch (err) {
    logger.error({ err }, "escalation.createRecord fail");
    return reply.code(500).send({ success: false, error: "Error creando registro de escalamiento" });
  }
}
export async function updateRecord(
  req: FastifyRequest<{ Params: { id: string }; Body: Partial<svc.EscalationRecord> }>,
  reply: FastifyReply
) {
  try {
    const r = await svc.updateRecord(req.params.id, req.body);
    if (!r) return reply.code(404).send({ success: false, error: "Registro no encontrado" });
    return reply.send({ success: true, record: r });
  } catch (err) {
    logger.error({ err }, "escalation.updateRecord fail");
    return reply.code(500).send({ success: false, error: "Error actualizando registro" });
  }
}

// ============================================================
// Connectors + Settings + Reset
// ============================================================
export async function updateConnectors(req: FastifyRequest<{ Body: Partial<svc.ItsmConnectorConfig> }>, reply: FastifyReply) {
  try {
    const c = await svc.updateConnectors(req.body);
    return reply.send({ success: true, connectors: c });
  } catch (err) {
    logger.error({ err }, "escalation.updateConnectors fail");
    return reply.code(500).send({ success: false, error: "Error actualizando conectores" });
  }
}
export async function updateSettings(req: FastifyRequest<{ Body: Partial<svc.EscalationSettings> }>, reply: FastifyReply) {
  try {
    const s = await svc.updateSettings(req.body);
    return reply.send({ success: true, settings: s });
  } catch (err) {
    logger.error({ err }, "escalation.updateSettings fail");
    return reply.code(500).send({ success: false, error: "Error actualizando configuración" });
  }
}
export async function postResetDemo(_req: FastifyRequest, reply: FastifyReply) {
  try {
    await svc.resetDemoData();
    const snap = await svc.getSnapshot();
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "escalation.reset fail");
    return reply.code(500).send({ success: false, error: "Error reseteando datos demo" });
  }
}
