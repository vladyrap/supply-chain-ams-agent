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
import { requireAuth } from "../middleware/requireAuth";
import { requirePermission } from "../middleware/requirePermission";

// FIX C7 (audit v1.1.0): rutas mutantes con RBAC.
// Agent Lab cae bajo screen "agente_ams" (no hay screen dedicado en RBAC).
// Wizard/Playground escriben prompt config → "configuracion" + action configure.
const READ = { preHandler: requireAuth };
const WRITE = { preHandler: requirePermission("agente_ams", "edit") };
const MANAGE = { preHandler: requirePermission("configuracion", "configure") };

export async function agentLabRoutes(app: FastifyInstance) {
  app.post("/api/agent-lab/feedback", READ, postFeedback as never);
  app.get("/api/agent-lab/feedback", READ, getFeedbackList as never);
  app.get("/api/agent-lab/feedback/stats", READ, getFeedbackStatsRoute);
  app.get<{ Params: { id: string } }>("/api/agent-lab/conversations/:id/trace", READ, getConversationTrace);

  app.get("/api/agent-lab/wizard/tickets", READ, getConvertibleTickets);
  app.post<{ Params: { id: string } }>("/api/agent-lab/wizard/draft/:id", WRITE, postWizardDraft);
  app.post("/api/agent-lab/wizard/commit", WRITE, postWizardCommit as never);

  app.post("/api/agent-lab/playground/run", WRITE, postPlaygroundRun as never);
  app.post("/api/agent-lab/playground/adopt", MANAGE, postAdoptPrompt as never);
  app.get("/api/agent-lab/playground/active", READ, getActivePromptRoute);
  app.get("/api/agent-lab/playground/versions", READ, listPromptVersionsRoute);
  app.post<{ Params: { id: string } }>("/api/agent-lab/playground/versions/:id/activate", MANAGE, postActivatePromptVersion);
}
