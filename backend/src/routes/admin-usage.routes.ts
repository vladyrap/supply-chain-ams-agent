// =============================================================================
// admin-usage.routes.ts — Endpoints admin de costos (v1.1.2-hotfix)
// =============================================================================
// FIX A3 (audit v1.1.0): RBAC obligatorio + tenant scoping en queries.
// Antes: endpoint público dentro del backend, panel platform "asumía" rol admin
// y costos eran globales cross-tenant. Ahora requirePermission("administracion",
// "view") y el service recibe req.tenantId para filtrar agent_usage.
// =============================================================================

import type { FastifyInstance, FastifyRequest } from "fastify";
import { getAdminUsageSummary } from "../services/admin-usage.service";
import { requirePermission } from "../middleware/requirePermission";
import { logger } from "../utils/logger";

export async function adminUsageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/admin/usage/summary
   * Resumen de gastos Gemini scoped al tenant del request.
   * super_admin con ?allTenants=true ve la suma cross-tenant.
   */
  app.get<{ Querystring: { allTenants?: string } }>(
    "/api/admin/usage/summary",
    { preHandler: requirePermission("administracion", "view") },
    async (req, reply) => {
      try {
        const isAdmin = (req.user?.role as string) === "admin";
        const allTenants = req.query.allTenants === "true";
        const scope = isAdmin && allTenants ? "*" : req.tenantId;
        const summary = await getAdminUsageSummary(scope);
        return reply.send({ success: true, ...summary });
      } catch (err) {
        logger.error({ err }, "GET /api/admin/usage/summary failed");
        return reply.status(500).send({
          success: false,
          error: "Error obteniendo summary de uso",
        });
      }
    },
  );
}
