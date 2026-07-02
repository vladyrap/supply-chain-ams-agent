// =============================================================================
// custom-agents.routes.ts — v1.3 Agent Hub
// =============================================================================
// Permission key: agente_ams
//   - view    → listar, ver, chatear, rating
//   - create  → crear agente
//   - edit    → editar agente propio
//   - delete  → borrar agente propio
// =============================================================================

import type { FastifyInstance } from "fastify";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/custom-agents.controller";

export async function customAgentsRoutes(app: FastifyInstance) {
  app.get("/api/agents",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.getAgents);

  app.get<{ Params: { id: string } }>("/api/agents/:id",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.getAgentById);

  app.post("/api/agents",
    { preHandler: requirePermission("agente_ams", "create") },
    ctrl.postAgent);

  app.put<{ Params: { id: string } }>("/api/agents/:id",
    { preHandler: requirePermission("agente_ams", "edit") },
    ctrl.putAgent);

  app.delete<{ Params: { id: string } }>("/api/agents/:id",
    { preHandler: requirePermission("agente_ams", "delete") },
    ctrl.deleteAgentById);

  app.post<{ Params: { id: string } }>("/api/agents/:id/rating",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.postAgentRating);

  app.post<{ Params: { id: string } }>("/api/agents/:id/chat",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.postAgentChat);
}
