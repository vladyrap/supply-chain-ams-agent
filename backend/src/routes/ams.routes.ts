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
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function amsRoutes(app: FastifyInstance) {
  // Chat con agente — create sobre agente_ams
  app.post("/api/ams/chat",
    { preHandler: requirePermission("agente_ams", "create") },
    postChat);
  app.post("/api/ams/chat/stream",
    { preHandler: requirePermission("agente_ams", "create") },
    postChatStream);
  // Research mode — create sobre agente_ams (mismo permiso)
  app.post("/api/ams/research",
    { preHandler: requirePermission("agente_ams", "create") },
    postResearch);
  app.post("/api/ams/research/stream",
    { preHandler: requirePermission("agente_ams", "create") },
    streamResearch);
  // Incidents (historial) — view sobre incidentes
  app.get("/api/ams/incidents",
    { preHandler: requirePermission("incidentes", "view") },
    getIncidents as never);
  app.get<{ Params: { id: string } }>("/api/ams/incidents/:id",
    { preHandler: requirePermission("incidentes", "view") },
    getIncident);
  // Audit legacy — view sobre audit_trail
  app.get("/api/ams/audit",
    { preHandler: requirePermission("audit_trail", "view") },
    getAudit);
  // Stats — view sobre dashboard
  app.get("/api/ams/stats",
    { preHandler: requirePermission("dashboard", "view") },
    getAmsStats);
}
