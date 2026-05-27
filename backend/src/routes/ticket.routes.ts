import type { FastifyInstance } from "fastify";
import {
  getTickets,
  getTicket,
  postClassifyTicket,
  getProviderStatus,
} from "../controllers/ticket.controller";

export async function ticketRoutes(app: FastifyInstance) {
  app.get("/api/tickets", getTickets);
  app.get("/api/tickets/provider", getProviderStatus);
  app.get<{ Params: { key: string } }>("/api/tickets/:key", getTicket);
  app.post<{ Params: { key: string } }>("/api/tickets/:key/classify", postClassifyTicket);
}
