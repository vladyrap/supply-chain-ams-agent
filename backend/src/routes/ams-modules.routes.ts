import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/ams-modules.controller";
import type { AmsPlaybook, PlaybookExecution } from "../services/playbooks.service";
import type { GeneratedDocument } from "../services/documents.service";
import type { AgentEvaluation } from "../services/quality-evaluator.service";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function amsModulesRoutes(app: FastifyInstance) {
  // ---------------- Playbooks ----------------
  app.get("/api/playbooks/snapshot",
    { preHandler: requirePermission("playbooks_ams", "view") },
    ctrl.getPlaybooksSnapshot);
  app.post<{ Body: AmsPlaybook }>("/api/playbooks",
    { preHandler: requirePermission("playbooks_ams", "create") },
    ctrl.upsertPlaybook);
  app.delete<{ Params: { id: string } }>("/api/playbooks/:id",
    { preHandler: requirePermission("playbooks_ams", "delete") },
    ctrl.deletePlaybook);
  app.post<{ Body: PlaybookExecution }>("/api/playbooks/executions",
    { preHandler: requirePermission("playbooks_ams", "create") },
    ctrl.upsertExecution);
  app.delete<{ Params: { id: string } }>("/api/playbooks/executions/:id",
    { preHandler: requirePermission("playbooks_ams", "delete") },
    ctrl.deleteExecution);
  app.post("/api/playbooks/reset-demo",
    { preHandler: requirePermission("playbooks_ams", "configure") },
    ctrl.resetPlaybooksDemo);

  // ---------------- Documents ----------------
  app.get("/api/documents/snapshot",
    { preHandler: requirePermission("document_factory", "view") },
    ctrl.getDocumentsSnapshot);
  app.post<{ Body: GeneratedDocument }>("/api/documents",
    { preHandler: requirePermission("document_factory", "create") },
    ctrl.upsertDocument);
  app.delete<{ Params: { id: string } }>("/api/documents/:id",
    { preHandler: requirePermission("document_factory", "delete") },
    ctrl.deleteDocument);
  app.post("/api/documents/reset-demo",
    { preHandler: requirePermission("document_factory", "configure") },
    ctrl.resetDocumentsDemo);

  // ---------------- Quality Evaluator ----------------
  app.get("/api/quality/snapshot",
    { preHandler: requirePermission("quality_evaluator", "view") },
    ctrl.getQualitySnapshot);
  app.post<{ Body: AgentEvaluation }>("/api/quality/evaluations",
    { preHandler: requirePermission("quality_evaluator", "create") },
    ctrl.upsertEvaluation);
  app.delete<{ Params: { id: string } }>("/api/quality/evaluations/:id",
    { preHandler: requirePermission("quality_evaluator", "delete") },
    ctrl.deleteEvaluation);
  app.post("/api/quality/reset-demo",
    { preHandler: requirePermission("quality_evaluator", "configure") },
    ctrl.resetQualityDemo);
}
