// =============================================================================
// admin-usage.routes.ts — Endpoints admin de costos (v0.12.4)
// =============================================================================

import type { FastifyInstance } from "fastify";
import { getAdminUsageSummary } from "../services/admin-usage.service";
import { logger } from "../utils/logger";

export async function adminUsageRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/admin/usage/summary
   * Devuelve resumen de gastos Gemini para el panel /admin/costs del platform.
   * NO requiere auth por ahora — el panel platform ya filtra por rol ADMIN.
   * En producción habilitar requirePermission middleware acá también.
   */
  app.get("/api/admin/usage/summary", async (_req, reply) => {
    try {
      const summary = await getAdminUsageSummary();
      return reply.send({ success: true, ...summary });
    } catch (err) {
      logger.error({ err }, "GET /api/admin/usage/summary failed");
      return reply.status(500).send({
        success: false,
        error: (err as Error).message,
      });
    }
  });
}
