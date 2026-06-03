import type { FastifyInstance } from "fastify";
import {
  postIngest,
  getDocuments,
  delDocument,
  getKnowledgeOverview,
  postIngestText,
  postIngestUrl,
  getDocumentChunks,
  postSearch,
} from "../controllers/knowledge.controller";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function knowledgeRoutes(app: FastifyInstance) {
  // Crear conocimiento — create sobre conocimiento_rag
  app.post("/api/knowledge/ingest",
    { preHandler: requirePermission("conocimiento_rag", "create") },
    postIngest as never);
  app.post("/api/knowledge/ingest-text",
    { preHandler: requirePermission("conocimiento_rag", "create") },
    postIngestText as never);
  app.post("/api/knowledge/ingest-url",
    { preHandler: requirePermission("conocimiento_rag", "create") },
    postIngestUrl as never);
  // Búsqueda RAG — view sobre conocimiento_rag
  app.post("/api/knowledge/search",
    { preHandler: requirePermission("conocimiento_rag", "view") },
    postSearch as never);
  app.get("/api/knowledge/documents",
    { preHandler: requirePermission("conocimiento_rag", "view") },
    getDocuments as never);
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/knowledge/documents/:id/chunks",
    { preHandler: requirePermission("conocimiento_rag", "view") },
    getDocumentChunks
  );
  app.delete<{ Params: { id: string } }>("/api/knowledge/documents/:id",
    { preHandler: requirePermission("conocimiento_rag", "delete") },
    delDocument);
  app.get("/api/knowledge/overview",
    { preHandler: requirePermission("conocimiento_rag", "view") },
    getKnowledgeOverview);
}
