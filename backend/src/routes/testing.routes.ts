import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/testing.controller";
import type {
  TestingScenario, EvidenceItem, TestDefect, GeneratedUserManual, TestingSettings,
} from "../services/testing.service";

export async function testingRoutes(app: FastifyInstance) {
  // Snapshot
  app.get("/api/testing/snapshot", ctrl.getSnapshot);

  // Scenarios
  app.post<{ Body: TestingScenario }>("/api/testing/scenarios", ctrl.upsertScenario);
  app.delete<{ Params: { id: string } }>("/api/testing/scenarios/:id", ctrl.deleteScenario);

  // Evidences (JSON: NOTE/LINK/LOG)
  app.post<{ Body: EvidenceItem }>("/api/testing/evidences", ctrl.createEvidenceJson);
  app.delete<{ Params: { id: string } }>("/api/testing/evidences/:id", ctrl.deleteEvidence);

  // Evidence binario (multipart)
  app.post("/api/testing/evidences/upload", ctrl.uploadEvidence);
  app.get<{ Params: { id: string } }>("/api/testing/evidences/:id/file", ctrl.getEvidenceFile);

  // Defects
  app.post<{ Body: TestDefect }>("/api/testing/defects", ctrl.upsertDefect);
  app.delete<{ Params: { id: string } }>("/api/testing/defects/:id", ctrl.deleteDefect);

  // Manuals
  app.post<{ Body: GeneratedUserManual }>("/api/testing/manuals", ctrl.upsertManual);

  // Settings + reset demo
  app.patch<{ Body: Partial<TestingSettings> }>("/api/testing/settings", ctrl.updateSettings);
  app.post("/api/testing/reset-demo", ctrl.postResetDemo);
}
