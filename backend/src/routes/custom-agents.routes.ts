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

  // Onda 5 — catálogo de modelos con disponibilidad (ruta estática gana a /:id)
  app.get("/api/agents/models",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.getModels);

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

  // Publicación al equipo (onda 4) — solo el creador; permiso edit
  app.post<{ Params: { id: string } }>("/api/agents/:id/publish",
    { preHandler: requirePermission("agente_ams", "edit") },
    ctrl.postAgentPublish);

  app.post<{ Params: { id: string } }>("/api/agents/:id/unpublish",
    { preHandler: requirePermission("agente_ams", "edit") },
    ctrl.postAgentUnpublish);

  // Onda 5 — duplicar / versiones / comparador
  app.post<{ Params: { id: string } }>("/api/agents/:id/duplicate",
    { preHandler: requirePermission("agente_ams", "create") },
    ctrl.postAgentDuplicate);

  app.get<{ Params: { id: string } }>("/api/agents/:id/versions",
    { preHandler: requirePermission("agente_ams", "edit") },
    ctrl.getAgentVersions);

  app.post<{ Params: { id: string; versionId: string } }>("/api/agents/:id/versions/:versionId/restore",
    { preHandler: requirePermission("agente_ams", "edit") },
    ctrl.postAgentRestore);

  app.post<{ Params: { id: string } }>("/api/agents/:id/compare",
    { preHandler: requirePermission("agente_ams", "edit") },
    ctrl.postAgentCompare);

  app.post<{ Params: { id: string } }>("/api/agents/:id/chat",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.postAgentChat);

  // Conversaciones persistentes (v1.3 F6)
  app.get<{ Params: { id: string } }>("/api/agents/:id/conversations",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.getAgentConversations);

  app.get<{ Params: { id: string } }>("/api/agent-conversations/:id",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.getConversationById);

  app.delete<{ Params: { id: string } }>("/api/agent-conversations/:id",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.deleteConversationById);
}
