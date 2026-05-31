import type { FastifyInstance } from "fastify";
import {
  getTickets,
  getTicket,
  postCreateTicket,
  postClassifyTicket,
  postRecalculateEstimate,
  patchManualEstimate,
  getProviderStatus,
} from "../controllers/ticket.controller";
import type { CreateTicketInput, ManualEstimatePatch } from "../services/ticket.service";

export async function ticketRoutes(app: FastifyInstance) {
  app.get("/api/tickets", getTickets);
  app.get("/api/tickets/provider", getProviderStatus);
  app.post<{ Body: CreateTicketInput }>("/api/tickets", postCreateTicket);
  app.get<{ Params: { key: string } }>("/api/tickets/:key", getTicket);
  app.post<{ Params: { key: string } }>("/api/tickets/:key/classify", postClassifyTicket);
  app.post<{ Params: { key: string }; Body: { force?: boolean; actor?: string } }>(
    "/api/tickets/:key/recalculate", postRecalculateEstimate);
  app.patch<{ Params: { key: string }; Body: ManualEstimatePatch & { actor: string; reason: string } }>(
    "/api/tickets/:key/estimate", patchManualEstimate);
}
