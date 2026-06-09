import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/training.controller";
import { requirePermission } from "../middleware/requirePermission";
import { requireAuth } from "../middleware/requireAuth";

// FIX C7 (audit v1.1.0): TODA ruta mutante requiere requirePermission.
// PlatformScreen mapping:
//   training → "entrenamiento_ia"
// Actions: edit (write), configure (manage/admin), delete (destructive).
const READ = { preHandler: requireAuth };
const WRITE = { preHandler: requirePermission("entrenamiento_ia", "edit") };
const CONFIGURE = { preHandler: requirePermission("entrenamiento_ia", "configure") };
const DELETE = { preHandler: requirePermission("entrenamiento_ia", "delete") };

export async function trainingRoutes(app: FastifyInstance) {
  app.get("/api/training/snapshot", READ, ctrl.getSnapshot);

  app.get("/api/training/items", READ, ctrl.listItems as never);
  app.post("/api/training/items", WRITE, ctrl.createItem as never);
  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/training/items/:id", WRITE, ctrl.updateItem
  );
  app.delete<{ Params: { id: string } }>("/api/training/items/:id", DELETE, ctrl.deleteItem);

  app.post("/api/training/qa", WRITE, ctrl.createQA as never);
  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/training/qa/:id", WRITE, ctrl.updateQA
  );
  app.delete<{ Params: { id: string } }>("/api/training/qa/:id", DELETE, ctrl.deleteQA);

  app.post("/api/training/versions", CONFIGURE, ctrl.createVersion as never);
  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/training/versions/:id/status", CONFIGURE, ctrl.setVersionStatus
  );

  app.post("/api/training/gaps", WRITE, ctrl.createGap as never);
  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/training/gaps/:id", WRITE, ctrl.updateGap
  );
  app.delete<{ Params: { id: string } }>("/api/training/gaps/:id", DELETE, ctrl.deleteGap);

  app.get("/api/training/settings", READ, ctrl.getSettings);
  app.patch("/api/training/settings", CONFIGURE, ctrl.updateSettings as never);

  app.post("/api/training/gaps/detect", WRITE, ctrl.postRunGapDetection as never);

  app.post("/api/training/eval/run", WRITE, ctrl.postRunQaEval as never);
  app.get("/api/training/eval/runs", READ, ctrl.getEvalRunsList);
  app.get<{ Params: { id: string } }>("/api/training/eval/runs/:id", READ, ctrl.getEvalRunDetailRoute);

  app.post("/api/training/eval/ab", CONFIGURE, ctrl.postAbTest as never);
  app.post("/api/training/eval/auto-promote", CONFIGURE, ctrl.postAutoPromote as never);
  app.get<{ Querystring: { a?: string; b?: string } }>("/api/training/eval/diff", READ, ctrl.getEvalDiff);

  app.post("/api/training/qa/propose-from-tickets", WRITE, ctrl.postProposeQasFromTickets as never);
  app.post("/api/training/qa/auto-generate", WRITE, ctrl.postAutoGenerateQas as never);

  app.post("/api/training/self/run", CONFIGURE, ctrl.postSelfTrainingRun as never);
  app.post("/api/training/seed/expand", CONFIGURE, ctrl.postLoadExpandedCorpus as never);

  app.get("/api/training/self/config", READ, ctrl.getSelfTrainingConfigRoute);
  app.patch("/api/training/self/config", CONFIGURE, ctrl.patchSelfTrainingConfigRoute as never);
  app.get("/api/training/self/history", READ, ctrl.getSelfTrainingHistoryRoute);

  app.post("/api/training/embeddings/backfill", CONFIGURE, ctrl.postBackfillEmbeddings as never);

  app.get<{ Querystring: { days?: string; threshold?: string } }>(
    "/api/training/eval/timeline", READ, ctrl.getEvalTimelineRoute
  );

  app.post("/api/training/feedback/patterns", WRITE, ctrl.postFeedbackPatterns as never);

  app.get<{ Params: { id: string } }>("/api/training/reasoning/:id", READ, ctrl.getReasoningTraceRoute);

  app.get("/api/training/hallucinations/report", READ, ctrl.getHallucinationReportRoute);
  app.get("/api/training/hallucinations/whitelist", READ, ctrl.getHallucinationWhitelist);
  app.post("/api/training/hallucinations/invalidate", CONFIGURE, ctrl.postInvalidateWhitelist as never);

  app.get<{ Querystring: { limit?: string } }>("/api/training/active/borderline", READ, ctrl.getBorderlineQAsRoute);
}
