import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/testing.controller";
import type {
  TestingScenario, EvidenceItem, TestDefect, GeneratedUserManual, TestingSettings,
} from "../services/testing.service";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function testingRoutes(app: FastifyInstance) {
  // Snapshot — view sobre testing_intelligence
  app.get("/api/testing/snapshot",
    { preHandler: requirePermission("testing_intelligence", "view") },
    ctrl.getSnapshot);

  // Scenarios — create / delete sobre testing_intelligence
  app.post<{ Body: TestingScenario }>("/api/testing/scenarios",
    { preHandler: requirePermission("testing_intelligence", "create") },
    ctrl.upsertScenario);
  app.delete<{ Params: { id: string } }>("/api/testing/scenarios/:id",
    { preHandler: requirePermission("testing_intelligence", "delete") },
    ctrl.deleteScenario);

  // Evidences (JSON: NOTE/LINK/LOG)
  app.post<{ Body: EvidenceItem }>("/api/testing/evidences",
    { preHandler: requirePermission("testing_intelligence", "create") },
    ctrl.createEvidenceJson);
  app.delete<{ Params: { id: string } }>("/api/testing/evidences/:id",
    { preHandler: requirePermission("testing_intelligence", "delete") },
    ctrl.deleteEvidence);

  // Evidence binario (multipart)
  app.post("/api/testing/evidences/upload",
    { preHandler: requirePermission("testing_intelligence", "create") },
    ctrl.uploadEvidence);
  app.get<{ Params: { id: string } }>("/api/testing/evidences/:id/file",
    { preHandler: requirePermission("testing_intelligence", "view") },
    ctrl.getEvidenceFile);

  // Defects
  app.post<{ Body: TestDefect }>("/api/testing/defects",
    { preHandler: requirePermission("testing_intelligence", "create") },
    ctrl.upsertDefect);
  app.delete<{ Params: { id: string } }>("/api/testing/defects/:id",
    { preHandler: requirePermission("testing_intelligence", "delete") },
    ctrl.deleteDefect);

  // Manuals
  app.post<{ Body: GeneratedUserManual }>("/api/testing/manuals",
    { preHandler: requirePermission("testing_intelligence", "create") },
    ctrl.upsertManual);

  // Settings + reset demo — configure
  app.patch<{ Body: Partial<TestingSettings> }>("/api/testing/settings",
    { preHandler: requirePermission("testing_intelligence", "configure") },
    ctrl.updateSettings);
  app.post("/api/testing/reset-demo",
    { preHandler: requirePermission("testing_intelligence", "configure") },
    ctrl.postResetDemo);

  // Cloud ALM
  app.get("/api/testing/cloud-alm/status",
    { preHandler: requirePermission("testing_intelligence", "view") },
    ctrl.getCloudAlmStatus);
  app.post("/api/testing/cloud-alm/export",
    { preHandler: requirePermission("testing_intelligence", "export") },
    ctrl.postCloudAlmExport as never);

  // Análisis IA de video (Whisper + Gemini) — create
  app.post<{ Params: { id: string }; Body?: { language?: string } }>(
    "/api/testing/evidences/:id/analyze",
    { preHandler: requirePermission("testing_intelligence", "create") },
    ctrl.postAnalyzeVideo as never
  );
}
