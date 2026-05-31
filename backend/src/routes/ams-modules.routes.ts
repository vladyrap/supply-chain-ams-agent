import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/ams-modules.controller";

export async function amsModulesRoutes(app: FastifyInstance) {
  // ---------------- Playbooks ----------------
  app.get("/api/playbooks/snapshot", ctrl.getPlaybooksSnapshot);
  app.post("/api/playbooks", ctrl.upsertPlaybook);
  app.delete<{ Params: { id: string } }>("/api/playbooks/:id", ctrl.deletePlaybook);
  app.post("/api/playbooks/executions", ctrl.upsertExecution);
  app.delete<{ Params: { id: string } }>("/api/playbooks/executions/:id", ctrl.deleteExecution);
  app.post("/api/playbooks/reset-demo", ctrl.resetPlaybooksDemo);

  // ---------------- Documents ----------------
  app.get("/api/documents/snapshot", ctrl.getDocumentsSnapshot);
  app.post("/api/documents", ctrl.upsertDocument);
  app.delete<{ Params: { id: string } }>("/api/documents/:id", ctrl.deleteDocument);
  app.post("/api/documents/reset-demo", ctrl.resetDocumentsDemo);

  // ---------------- Quality Evaluator ----------------
  app.get("/api/quality/snapshot", ctrl.getQualitySnapshot);
  app.post("/api/quality/evaluations", ctrl.upsertEvaluation);
  app.delete<{ Params: { id: string } }>("/api/quality/evaluations/:id", ctrl.deleteEvaluation);
  app.post("/api/quality/reset-demo", ctrl.resetQualityDemo);
}
