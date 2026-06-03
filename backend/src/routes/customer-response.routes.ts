import type { FastifyInstance } from "fastify";
import {
  postSaveResponse, getListByTicket, patchStatus, deleteOne, getOne,
} from "../controllers/customer-response.controller";
import type { SaveCustomerResponseInput } from "../services/customer-response.service";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function customerResponseRoutes(app: FastifyInstance) {
  // Guardar respuesta — create sobre quality_evaluator (donde vive el quality gate)
  app.post<{ Params: { key: string }; Body: SaveCustomerResponseInput }>(
    "/api/tickets/:key/responses",
    { preHandler: requirePermission("quality_evaluator", "create") },
    postSaveResponse);
  // Listar respuestas por ticket — view sobre ticket_command_center
  app.get<{ Params: { key: string } }>(
    "/api/tickets/:key/responses",
    { preHandler: requirePermission("ticket_command_center", "view") },
    getListByTicket);
  // Detalle de una respuesta — view sobre ticket_command_center
  app.get<{ Params: { responseId: string } }>(
    "/api/customer-responses/:responseId",
    { preHandler: requirePermission("ticket_command_center", "view") },
    getOne);
  // Cambiar estado (aprobar/bloquear/enviar) — approve sobre quality_evaluator
  app.patch<{ Params: { responseId: string }; Body: { status: string } }>(
    "/api/customer-responses/:responseId/status",
    { preHandler: requirePermission("quality_evaluator", "approve") },
    patchStatus);
  // Eliminar — delete sobre quality_evaluator
  app.delete<{ Params: { responseId: string } }>(
    "/api/customer-responses/:responseId",
    { preHandler: requirePermission("quality_evaluator", "delete") },
    deleteOne);
}
