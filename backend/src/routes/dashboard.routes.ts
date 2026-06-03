import type { FastifyInstance } from "fastify";
import {
  getDashboardAdv,
  getDashboardExec,
  getUsageRoute,
  getNotificationsRoute,
} from "../controllers/dashboard.controller";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function dashboardRoutes(app: FastifyInstance) {
  // Handlers tipados con Querystring → cast `as never` para evitar choque con preHandler
  app.get("/api/dashboard/advanced",
    { preHandler: requirePermission("dashboard", "view") },
    getDashboardAdv as never);
  app.get("/api/dashboard/executive",
    { preHandler: requirePermission("reportes", "view") },
    getDashboardExec as never);
  app.get("/api/dashboard/usage",
    { preHandler: requirePermission("dashboard", "view") },
    getUsageRoute as never);
  app.get("/api/notifications",
    { preHandler: requirePermission("dashboard", "view") },
    getNotificationsRoute as never);
}
