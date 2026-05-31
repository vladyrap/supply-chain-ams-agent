import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/escalation.controller";
import type { EscalationRecord } from "../services/escalation.service";

export async function escalationRoutes(app: FastifyInstance) {
  // Snapshot hidrata todo el centro de escalamiento al frontend
  app.get("/api/escalation/snapshot", ctrl.getSnapshot);

  // Rules
  app.post("/api/escalation/rules", ctrl.upsertRule);
  app.delete<{ Params: { id: string } }>("/api/escalation/rules/:id", ctrl.deleteRule);

  // Responsibles N2
  app.post("/api/escalation/responsibles", ctrl.upsertResponsible);
  app.delete<{ Params: { id: string } }>("/api/escalation/responsibles/:id", ctrl.deleteResponsible);

  // Records (escalamientos)
  app.post("/api/escalation/records", ctrl.createRecord);
  app.patch<{ Params: { id: string }; Body: Partial<EscalationRecord> }>(
    "/api/escalation/records/:id", ctrl.updateRecord
  );

  // Connectors ITSM + Settings
  app.patch("/api/escalation/connectors", ctrl.updateConnectors);
  app.patch("/api/escalation/settings", ctrl.updateSettings);

  // Reset demo
  app.post("/api/escalation/reset-demo", ctrl.postResetDemo);

  // ITSM adapters (Jira / ServiceNow real)
  app.get("/api/escalation/itsm/status", ctrl.getItsmStatus);
  app.post<{ Params: { id: string }; Body: { payload: unknown; confirmReal?: boolean; by?: string } }>(
    "/api/escalation/records/:id/send-jira",
    ctrl.postSendJira as never
  );
  app.post<{ Params: { id: string }; Body: { payload: unknown; confirmReal?: boolean; by?: string } }>(
    "/api/escalation/records/:id/send-servicenow",
    ctrl.postSendServiceNow as never
  );
}
