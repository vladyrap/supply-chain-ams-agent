import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/escalation.controller";
import type { EscalationRecord } from "../services/escalation.service";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function escalationRoutes(app: FastifyInstance) {
  // Snapshot hidrata todo el centro de escalamiento al frontend
  app.get("/api/escalation/snapshot",
    { preHandler: requirePermission("escalamiento_n2", "view") },
    ctrl.getSnapshot);

  // Rules — configure sobre escalamiento_n2
  app.post("/api/escalation/rules",
    { preHandler: requirePermission("escalamiento_n2", "configure") },
    ctrl.upsertRule as never);
  app.delete<{ Params: { id: string } }>("/api/escalation/rules/:id",
    { preHandler: requirePermission("escalamiento_n2", "configure") },
    ctrl.deleteRule);

  // Responsibles N2 — configure
  app.post("/api/escalation/responsibles",
    { preHandler: requirePermission("escalamiento_n2", "configure") },
    ctrl.upsertResponsible as never);
  app.delete<{ Params: { id: string } }>("/api/escalation/responsibles/:id",
    { preHandler: requirePermission("escalamiento_n2", "configure") },
    ctrl.deleteResponsible);

  // Records (escalamientos) — create / edit
  app.post("/api/escalation/records",
    { preHandler: requirePermission("escalamiento_n2", "create") },
    ctrl.createRecord as never);
  app.patch<{ Params: { id: string }; Body: Partial<EscalationRecord> }>(
    "/api/escalation/records/:id",
    { preHandler: requirePermission("escalamiento_n2", "edit") },
    ctrl.updateRecord
  );

  // Connectors ITSM + Settings — configure
  app.patch("/api/escalation/connectors",
    { preHandler: requirePermission("escalamiento_n2", "configure") },
    ctrl.updateConnectors as never);
  app.patch("/api/escalation/settings",
    { preHandler: requirePermission("escalamiento_n2", "configure") },
    ctrl.updateSettings as never);

  // Reset demo — configure
  app.post("/api/escalation/reset-demo",
    { preHandler: requirePermission("escalamiento_n2", "configure") },
    ctrl.postResetDemo);

  // ITSM adapters (Jira / ServiceNow real)
  app.get("/api/escalation/itsm/status",
    { preHandler: requirePermission("escalamiento_n2", "view") },
    ctrl.getItsmStatus);
  // Envío real a Jira/ServiceNow → approve (sólo SERVICE_LEAD+ envían a producción)
  app.post<{ Params: { id: string }; Body: { payload: unknown; confirmReal?: boolean; by?: string } }>(
    "/api/escalation/records/:id/send-jira",
    { preHandler: requirePermission("escalamiento_n2", "approve") },
    ctrl.postSendJira as never
  );
  app.post<{ Params: { id: string }; Body: { payload: unknown; confirmReal?: boolean; by?: string } }>(
    "/api/escalation/records/:id/send-servicenow",
    { preHandler: requirePermission("escalamiento_n2", "approve") },
    ctrl.postSendServiceNow as never
  );
}
