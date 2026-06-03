import type { FastifyInstance } from "fastify";
import {
  getEvents, getByTicket, postEvent, getSummary,
} from "../controllers/audit-events.controller";
import { requirePermission } from "../middleware/requirePermission";
import { requireAuth } from "../middleware/requireAuth";

export async function auditEventsRoutes(app: FastifyInstance) {
  // GET listado — view sobre audit_trail (sólo aprob/admin por default)
  app.get("/api/audit/events",
    { preHandler: requirePermission("audit_trail", "view") },
    getEvents as never);

  // GET por ticket — view sobre audit_trail
  app.get<{ Params: { ticketKey: string } }>(
    "/api/audit/events/by-ticket/:ticketKey",
    { preHandler: requirePermission("audit_trail", "view") },
    getByTicket
  );

  // POST evento — sólo requiere estar autenticado.
  // Cualquier user puede emitir eventos (los suyos), el actor se resuelve
  // desde request.user. Los eventos críticos los emite el backend internamente.
  app.post("/api/audit/events",
    { preHandler: requireAuth },
    postEvent as never);

  // GET summary — view sobre audit_trail
  app.get("/api/audit/summary",
    { preHandler: requirePermission("audit_trail", "view") },
    getSummary);
}
