import type { FastifyInstance } from "fastify";
import {
  getTickets,
  getTicket,
  postCreateTicket,
  postClassifyTicket,
  getProviderStatus,
} from "../controllers/ticket.controller";
import type { CreateTicketInput } from "../services/ticket.service";

export async function ticketRoutes(app: FastifyInstance) {
  app.get("/api/tickets", getTickets);
  app.get("/api/tickets/provider", getProviderStatus);
  app.post<{ Body: CreateTicketInput }>("/api/tickets", postCreateTicket);
  app.get<{ Params: { key: string } }>("/api/tickets/:key", getTicket);
  app.post<{ Params: { key: string } }>("/api/tickets/:key/classify", postClassifyTicket);
}
