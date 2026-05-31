import type { FastifyInstance } from "fastify";
import { getScopeItems, getScopeItem, postSuggestForTicket } from "../controllers/scope-items.controller";

export async function scopeItemsRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { module?: string } }>("/api/scope-items", getScopeItems);
  app.get<{ Params: { code: string } }>("/api/scope-items/:code", getScopeItem);
  app.post<{ Body: { module?: string; title?: string; description?: string } }>(
    "/api/scope-items/suggest", postSuggestForTicket);
}
