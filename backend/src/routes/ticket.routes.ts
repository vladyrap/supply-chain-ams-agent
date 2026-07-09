import type { FastifyInstance } from "fastify";
import {
  getTickets,
  getTicket,
  postCreateTicket,
  postClassifyTicket,
  postRecalculateEstimate,
  patchManualEstimate,
  postCloseTicket,
  postReplaceEstimate,
  getProviderStatus,
  putTicketIntelligence,
  getTicketIntelligenceHandler,
  getTicketIntelligenceHistory,
  getTicketTimeline,
  patchTicketGeneral,
} from "../controllers/ticket.controller";
import type {
  CreateTicketInput, ManualEstimatePatch, CloseTicketInput, TicketIntelligence,
} from "../services/ticket.service";
import type { TicketEstimatedResolution } from "../utils/estimation";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function ticketRoutes(app: FastifyInstance) {
  // Lectura — view sobre ticket_command_center
  app.get("/api/tickets",
    { preHandler: requirePermission("ticket_command_center", "view") },
    getTickets);
  app.get("/api/tickets/provider",
    { preHandler: requirePermission("ticket_command_center", "view") },
    getProviderStatus);
  app.get<{ Params: { key: string } }>("/api/tickets/:key",
    { preHandler: requirePermission("ticket_command_center", "view") },
    getTicket);

  // Crear — create sobre ticket_command_center
  app.post<{ Body: CreateTicketInput }>("/api/tickets",
    { preHandler: requirePermission("ticket_command_center", "create") },
    postCreateTicket);

  // Clasificar con agente — create sobre agente_ams
  app.post<{ Params: { key: string } }>("/api/tickets/:key/classify",
    { preHandler: requirePermission("agente_ams", "create") },
    postClassifyTicket);

  // Recalcular estimación — edit sobre time_estimator
  app.post<{ Params: { key: string }; Body: { force?: boolean; actor?: string } }>(
    "/api/tickets/:key/recalculate",
    { preHandler: requirePermission("time_estimator", "edit") },
    postRecalculateEstimate);

  // Ajuste manual de estimación — edit sobre time_estimator
  app.patch<{ Params: { key: string }; Body: ManualEstimatePatch & { actor: string; reason: string } }>(
    "/api/tickets/:key/estimate",
    { preHandler: requirePermission("time_estimator", "edit") },
    patchManualEstimate);

  // Cerrar ticket — edit sobre ticket_command_center
  app.post<{ Params: { key: string }; Body: CloseTicketInput }>(
    "/api/tickets/:key/close",
    { preHandler: requirePermission("ticket_command_center", "edit") },
    postCloseTicket);

  // Sobrescribir estimación contextual — edit sobre time_estimator
  app.post<{ Params: { key: string }; Body: { estimate: TicketEstimatedResolution; actor: string; reason?: string } }>(
    "/api/tickets/:key/estimate/full",
    { preHandler: requirePermission("time_estimator", "edit") },
    postReplaceEstimate);

  // AIE v0.10 — Auto Intelligence Enrichment
  // PUT intelligence (persistir resultado del pipeline frontend)
  // FIX M14 (audit v1.1.0): bodyLimit reducido a 256KB (analisis intelligence
  // no debería pasar de eso) + schema validation. Antes: 30MB global permitía
  // DoS guardando blob en columna JSONB.
  app.put<{ Params: { key: string }; Body: { intelligence: TicketIntelligence } }>(
    "/api/tickets/:key/intelligence",
    {
      preHandler: requirePermission("ticket_command_center", "edit"),
      bodyLimit: 256 * 1024,
      schema: {
        body: {
          type: "object",
          required: ["intelligence"],
          properties: {
            intelligence: {
              type: "object",
              // Validación liviana — no enforce todos los campos, solo
              // que sea objeto y status si presente sea string conocido.
              properties: {
                status: { type: "string", maxLength: 32 },
                inputHash: { type: "string", maxLength: 128 },
                analysisVersion: { type: "integer" },
              },
              additionalProperties: true,
            },
          },
        },
      },
    },
    putTicketIntelligence);
  // GET intelligence (lighter que GET /tickets/:key — útil para badge en lista)
  app.get<{ Params: { key: string } }>(
    "/api/tickets/:key/intelligence",
    { preHandler: requirePermission("ticket_command_center", "view") },
    getTicketIntelligenceHandler);

  // TCC v0.12 — historial de versiones del intelligence
  app.get<{ Params: { key: string } }>(
    "/api/tickets/:key/intelligence/history",
    { preHandler: requirePermission("ticket_command_center", "view") },
    getTicketIntelligenceHistory);

  // Case Timeline (F0) — read-model unificado (audit_events + intelligence_history)
  app.get<{ Params: { key: string }; Querystring: { limit?: string } }>(
    "/api/tickets/:key/timeline",
    { preHandler: requirePermission("ticket_command_center", "view") },
    getTicketTimeline);

  // TCC v0.12 — PATCH ticket campos generales (title, description, sapModule,
  // environment, priority, assignee, reporter, status). Whitelist en service.
  app.patch<{ Params: { key: string }; Body: Partial<{
    title: string; description: string; sapModule: string | null;
    environment: string | null; priority: string;
    assignee: string | null; reporter: string | null; status: string;
  }> }>(
    "/api/tickets/:key",
    { preHandler: requirePermission("ticket_command_center", "edit") },
    patchTicketGeneral);
}
