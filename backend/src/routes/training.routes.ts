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
}
