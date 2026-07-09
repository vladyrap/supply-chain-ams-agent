// =============================================================================
// admin-users.routes.ts — v1.2.8-prod
// POST /api/admin/users/invite — crear cuenta + enviar email de bienvenida
// =============================================================================

import type { FastifyInstance } from "fastify";
import { requirePermission } from "../middleware/requirePermission";
import { postInviteUser, postUserResetLink } from "../controllers/admin-users.controller";

export async function adminUsersRoutes(app: FastifyInstance) {
  app.post(
    "/api/admin/users/invite",
    { preHandler: requirePermission("administracion", "configure") },
    postInviteUser as never,
  );
  app.post(
    "/api/admin/users/reset-link",
    { preHandler: requirePermission("administracion", "configure") },
    postUserResetLink as never,
  );
}
