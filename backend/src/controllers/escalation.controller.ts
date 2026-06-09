import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import * as svc from "../services/escalation.service";
import { createJiraIssue, jiraStatus, type JiraPayload } from "../services/jira.service";
import { createServiceNowIncident, serviceNowStatus, type ServiceNowPayload } from "../services/servicenow.service";

// ============================================================
// Snapshot
// ============================================================
export async function getSnapshot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const snap = await svc.getSnapshot(req.tenantId);
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
    const r = await svc.upsertRule(req.tenantId, req.body);
    return reply.send({ success: true, rule: r });
  } catch (err) {
    logger.error({ err }, "escalation.upsertRule fail");
    return reply.code(500).send({ success: false, error: "Error guardando regla" });
  }
}
export async function deleteRule(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    await svc.deleteRule(req.tenantId, req.params.id);
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
    const r = await svc.upsertResponsible(req.tenantId, req.body);
    return reply.send({ success: true, responsible: r });
  } catch (err) {
    logger.error({ err }, "escalation.upsertResponsible fail");
    return reply.code(500).send({ success: false, error: "Error guardando responsable" });
  }
}
export async function deleteResponsible(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try {
    await svc.deleteResponsible(req.tenantId, req.params.id);
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
    const r = await svc.createRecord(req.tenantId, req.body);
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
    const r = await svc.updateRecord(req.tenantId, req.params.id, req.body);
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
    const c = await svc.updateConnectors(req.tenantId, req.body);
    return reply.send({ success: true, connectors: c });
  } catch (err) {
    logger.error({ err }, "escalation.updateConnectors fail");
    return reply.code(500).send({ success: false, error: "Error actualizando conectores" });
  }
}
export async function updateSettings(req: FastifyRequest<{ Body: Partial<svc.EscalationSettings> }>, reply: FastifyReply) {
  try {
    const s = await svc.updateSettings(req.tenantId, req.body);
    return reply.send({ success: true, settings: s });
  } catch (err) {
    logger.error({ err }, "escalation.updateSettings fail");
    return reply.code(500).send({ success: false, error: "Error actualizando configuración" });
  }
}
export async function postResetDemo(req: FastifyRequest, reply: FastifyReply) {
  try {
    await svc.resetDemoData(req.tenantId);
    const snap = await svc.getSnapshot(req.tenantId);
    return reply.send({ success: true, ...snap });
  } catch (err) {
    logger.error({ err }, "escalation.reset fail");
    return reply.code(500).send({ success: false, error: "Error reseteando datos demo" });
  }
}

// ============================================================
// ITSM adapters status
// ============================================================
export async function getItsmStatus(_req: FastifyRequest, reply: FastifyReply) {
  try {
    return reply.send({
      success: true,
      jira: jiraStatus(),
      serviceNow: serviceNowStatus(),
    });
  } catch (err) {
    logger.error({ err }, "escalation.itsmStatus fail");
    return reply.code(500).send({ success: false, error: "Error consultando estado ITSM" });
  }
}

// ============================================================
// Send to Jira (REAL if env vars present + confirmReal=true)
// ============================================================
export async function postSendJira(
  req: FastifyRequest<{ Params: { id: string }; Body: { payload: JiraPayload; confirmReal?: boolean; by?: string } }>,
  reply: FastifyReply
) {
  try {
    const { payload, confirmReal, by } = req.body || ({} as { payload?: JiraPayload; confirmReal?: boolean; by?: string });
    if (!payload) return reply.code(400).send({ success: false, error: "payload requerido" });

    const result = await createJiraIssue(payload, { confirmReal });
    // Actualizar el record con el ticket externo
    const recPatch: Partial<svc.EscalationRecord> = {
      status: "ESCALATED",
      externalTicketId: result.ticketId,
      externalTicketUrl: result.ticketUrl,
      mode: result.mode as svc.ItsmMode,
      payload: { channel: "JIRA", payload },
    };
    const cur = await svc.updateRecord(req.tenantId, req.params.id, recPatch);
    if (cur) {
      // Append event
      const event = {
        type: "SENT_TO_JIRA",
        at: new Date().toISOString(),
        by: by || "system",
        note: result.ok ? `Ticket ${result.mode}: ${result.ticketId}` : `Falla: ${result.error}`,
      };
      await svc.updateRecord(req.tenantId, req.params.id, { events: [...(cur.events || []), event] });
    }
    return reply.send({ success: true, result });
  } catch (err) {
    logger.error({ err }, "escalation.sendJira fail");
    return reply.code(500).send({ success: false, error: "Error enviando a Jira" });
  }
}

// ============================================================
// Send to ServiceNow
// ============================================================
export async function postSendServiceNow(
  req: FastifyRequest<{ Params: { id: string }; Body: { payload: ServiceNowPayload; confirmReal?: boolean; by?: string } }>,
  reply: FastifyReply
) {
  try {
    const { payload, confirmReal, by } = req.body || ({} as { payload?: ServiceNowPayload; confirmReal?: boolean; by?: string });
    if (!payload) return reply.code(400).send({ success: false, error: "payload requerido" });

    const result = await createServiceNowIncident(payload, { confirmReal });
    const recPatch: Partial<svc.EscalationRecord> = {
      status: "ESCALATED",
      externalTicketId: result.ticketId,
      externalTicketUrl: result.ticketUrl,
      mode: result.mode as svc.ItsmMode,
      payload: { channel: "SERVICENOW", payload },
    };
    const cur = await svc.updateRecord(req.tenantId, req.params.id, recPatch);
    if (cur) {
      const event = {
        type: "SENT_TO_SERVICENOW",
        at: new Date().toISOString(),
        by: by || "system",
        note: result.ok ? `Incident ${result.mode}: ${result.ticketId}` : `Falla: ${result.error}`,
      };
      await svc.updateRecord(req.tenantId, req.params.id, { events: [...(cur.events || []), event] });
    }
    return reply.send({ success: true, result });
  } catch (err) {
    logger.error({ err }, "escalation.sendServiceNow fail");
    return reply.code(500).send({ success: false, error: "Error enviando a ServiceNow" });
  }
}
