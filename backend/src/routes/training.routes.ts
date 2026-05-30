import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/training.controller";

export async function trainingRoutes(app: FastifyInstance) {
  // Snapshot completo
  app.get("/api/training/snapshot", ctrl.getSnapshot);

  // Knowledge items
  app.get("/api/training/items", ctrl.listItems);
  app.post("/api/training/items", ctrl.createItem);
  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/training/items/:id", ctrl.updateItem
  );
  app.delete<{ Params: { id: string } }>("/api/training/items/:id", ctrl.deleteItem);

  // Q&A
  app.post("/api/training/qa", ctrl.createQA);
  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/training/qa/:id", ctrl.updateQA
  );
  app.delete<{ Params: { id: string } }>("/api/training/qa/:id", ctrl.deleteQA);

  // Versions
  app.post("/api/training/versions", ctrl.createVersion);
  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/training/versions/:id/status", ctrl.setVersionStatus
  );

  // Gaps
  app.post("/api/training/gaps", ctrl.createGap);
  app.patch<{ Params: { id: string }; Body: any }>(
    "/api/training/gaps/:id", ctrl.updateGap
  );
  app.delete<{ Params: { id: string } }>("/api/training/gaps/:id", ctrl.deleteGap);

  // Settings (singleton)
  app.get("/api/training/settings", ctrl.getSettings);
  app.patch("/api/training/settings", ctrl.updateSettings);

  // Auto-detección de brechas
  app.post("/api/training/gaps/detect", ctrl.postRunGapDetection);

  // Evaluación automática de Q&A
  app.post("/api/training/eval/run", ctrl.postRunQaEval);
  app.get("/api/training/eval/runs", ctrl.getEvalRunsList);
  app.get<{ Params: { id: string } }>("/api/training/eval/runs/:id", ctrl.getEvalRunDetailRoute);

  // A/B testing + Auto-promote + Diff
  app.post("/api/training/eval/ab", ctrl.postAbTest);
  app.post("/api/training/eval/auto-promote", ctrl.postAutoPromote);
  app.get<{ Querystring: { a?: string; b?: string } }>("/api/training/eval/diff", ctrl.getEvalDiff);

  // Tickets resueltos -> Q&A propuestas
  app.post("/api/training/qa/propose-from-tickets", ctrl.postProposeQasFromTickets);

  // Auto-generador de Q&A para items publicados sin Q&A
  app.post("/api/training/qa/auto-generate", ctrl.postAutoGenerateQas);

  // Self-training cycle (orchestrator)
  app.post("/api/training/self/run", ctrl.postSelfTrainingRun);

  // Cargar corpus expandido (26 items + Q&A aprobadas)
  app.post("/api/training/seed/expand", ctrl.postLoadExpandedCorpus);

  // Self-training CRON config + historial
  app.get("/api/training/self/config", ctrl.getSelfTrainingConfigRoute);
  app.patch("/api/training/self/config", ctrl.patchSelfTrainingConfigRoute);
  app.get("/api/training/self/history", ctrl.getSelfTrainingHistoryRoute);

  // Embeddings backfill (semantic few-shot)
  app.post("/api/training/embeddings/backfill", ctrl.postBackfillEmbeddings);

  // Timeline + drift
  app.get<{ Querystring: { days?: string; threshold?: string } }>(
    "/api/training/eval/timeline", ctrl.getEvalTimelineRoute
  );

  // Feedback patterns -> auto-curation
  app.post("/api/training/feedback/patterns", ctrl.postFeedbackPatterns);

  // Reasoning trace por response_id
  app.get<{ Params: { id: string } }>("/api/training/reasoning/:id", ctrl.getReasoningTraceRoute);

  // Hallucination detection
  app.get("/api/training/hallucinations/report", ctrl.getHallucinationReportRoute);
  app.get("/api/training/hallucinations/whitelist", ctrl.getHallucinationWhitelist);
  app.post("/api/training/hallucinations/invalidate", ctrl.postInvalidateWhitelist);

  // Active learning · borderline Q&A
  app.get<{ Querystring: { limit?: string } }>("/api/training/active/borderline", ctrl.getBorderlineQAsRoute);
}
