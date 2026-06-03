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
} from "../controllers/ticket.controller";
import type { CreateTicketInput, ManualEstimatePatch, CloseTicketInput } from "../services/ticket.service";
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
}
