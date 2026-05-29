import type { FastifyInstance } from "fastify";
import {
  postFeedback,
  getFeedbackList,
  getFeedbackStatsRoute,
  getConversationTrace,
  getConvertibleTickets,
  postWizardDraft,
  postWizardCommit,
  postPlaygroundRun,
  postAdoptPrompt,
  getActivePromptRoute,
  listPromptVersionsRoute,
  postActivatePromptVersion,
} from "../controllers/feedback.controller";

export async function agentLabRoutes(app: FastifyInstance) {
  // Feedback
  app.post("/api/agent-lab/feedback", postFeedback);
  app.get("/api/agent-lab/feedback", getFeedbackList);
  app.get("/api/agent-lab/feedback/stats", getFeedbackStatsRoute);
  app.get<{ Params: { id: string } }>("/api/agent-lab/conversations/:id/trace", getConversationTrace);

  // Wizard ticket → KB
  app.get("/api/agent-lab/wizard/tickets", getConvertibleTickets);
  app.post<{ Params: { id: string } }>("/api/agent-lab/wizard/draft/:id", postWizardDraft);
  app.post("/api/agent-lab/wizard/commit", postWizardCommit);

  // Prompt Playground
  app.post("/api/agent-lab/playground/run", postPlaygroundRun);

  // Prompt versioning — adoptar variante del Playground como activa
  app.post("/api/agent-lab/playground/adopt", postAdoptPrompt);
  app.get("/api/agent-lab/playground/active", getActivePromptRoute);
  app.get("/api/agent-lab/playground/versions", listPromptVersionsRoute);
  app.post<{ Params: { id: string } }>("/api/agent-lab/playground/versions/:id/activate", postActivatePromptVersion);
}
