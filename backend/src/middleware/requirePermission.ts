// =============================================================================
// requirePermission — Fastify preHandler que combina auth + RBAC check.
// =============================================================================
// Uso:
//   fastify.post(
//     "/api/tickets/:key/close",
//     { preHandler: requirePermission("ticket_command_center", "edit") },
//     handler,
//   );
//
// Flujo:
//   1) Llama internamente a requireAuth → 401 si no hay sesión.
//   2) Llama a hasPermission(user, screen, action) → 403 si no permitido.
//   3) Si permitido, sigue al handler.
//   4) En caso de 403, registra UNAUTHORIZED_API_ACCESS_ATTEMPT en audit
//      (best-effort, no bloqueante).
// =============================================================================

import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "./requireAuth";
import { hasPermission } from "../services/rbac-permission.service";
import { recordAudit } from "../services/audit.service";
import type { PlatformScreen, PermissionAction } from "../types/permissions.types";
import { logger } from "../utils/logger";

export function requirePermission(screen: PlatformScreen, action: PermissionAction) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // 1) Auth primero
    await requireAuth(req, reply);
    if (reply.sent) return; // requireAuth ya respondió 401

    // 2) Permission check
    const user = req.user;
    if (!user) {
      // Defensivo — no debería pasar si requireAuth corrió bien
      reply.code(401).send({ success: false, error: "Sesión requerida" });
      return;
    }
    const allowed = await hasPermission(user, screen, action);
    if (!allowed) {
      // Audit best-effort
      recordAudit("UNAUTHORIZED_API_ACCESS_ATTEMPT", {
        userId: user.id,
        userEmail: user.email,
        role: user.role,
        screen,
        action,
        path: req.url,
        method: req.method,
      }).catch((err) => logger.debug({ err }, "audit unauthorized failed"));

      reply.code(403).send({
        success: false,
        error: "Permiso insuficiente",
        screen,
        action,
      });
      return;
    }
    // ok → handler continúa
  };
}
