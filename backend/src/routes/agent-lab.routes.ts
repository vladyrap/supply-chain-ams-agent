import type { FastifyInstance } from "fastify";
import {
  postFeedback,
  getFeedbackList,
  getFeedbackStatsRoute,
  getConversationTrace,
} from "../controllers/feedback.controller";

export async function agentLabRoutes(app: FastifyInstance) {
  app.post("/api/agent-lab/feedback", postFeedback);
  app.get("/api/agent-lab/feedback", getFeedbackList);
  app.get("/api/agent-lab/feedback/stats", getFeedbackStatsRoute);
  app.get<{ Params: { id: string } }>("/api/agent-lab/conversations/:id/trace", getConversationTrace);
}
