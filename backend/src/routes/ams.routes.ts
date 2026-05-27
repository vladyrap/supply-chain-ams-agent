import type { FastifyInstance } from "fastify";
import {
  postChat,
  postChatStream,
  postResearch,
  streamResearch,
  getIncidents,
  getIncident,
  getAudit,
  getAmsStats,
} from "../controllers/ams.controller";

export async function amsRoutes(app: FastifyInstance) {
  app.post("/api/ams/chat", postChat);
  app.post("/api/ams/chat/stream", postChatStream);
  app.post("/api/ams/research", postResearch);
  app.post("/api/ams/research/stream", streamResearch);
  app.get("/api/ams/incidents", getIncidents);
  app.get<{ Params: { id: string } }>("/api/ams/incidents/:id", getIncident);
  app.get("/api/ams/audit", getAudit);
  app.get("/api/ams/stats", getAmsStats);
}
