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

export async function knowledgeRoutes(app: FastifyInstance) {
  app.post("/api/knowledge/ingest", postIngest);
  app.post("/api/knowledge/ingest-text", postIngestText);
  app.post("/api/knowledge/ingest-url", postIngestUrl);
  app.post("/api/knowledge/search", postSearch);
  app.get("/api/knowledge/documents", getDocuments);
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/knowledge/documents/:id/chunks",
    getDocumentChunks
  );
  app.delete<{ Params: { id: string } }>("/api/knowledge/documents/:id", delDocument);
  app.get("/api/knowledge/overview", getKnowledgeOverview);
}
