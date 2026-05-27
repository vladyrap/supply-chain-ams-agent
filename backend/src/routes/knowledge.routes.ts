import type { FastifyInstance } from "fastify";
import {
  postIngest,
  getDocuments,
  delDocument,
  getKnowledgeOverview,
} from "../controllers/knowledge.controller";

export async function knowledgeRoutes(app: FastifyInstance) {
  app.post("/api/knowledge/ingest", postIngest);
  app.get("/api/knowledge/documents", getDocuments);
  app.delete<{ Params: { id: string } }>("/api/knowledge/documents/:id", delDocument);
  app.get("/api/knowledge/overview", getKnowledgeOverview);
}
