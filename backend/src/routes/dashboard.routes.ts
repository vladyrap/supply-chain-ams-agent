import type { FastifyInstance } from "fastify";
import {
  getDashboardAdv,
  getDashboardExec,
  getUsageRoute,
  getNotificationsRoute,
} from "../controllers/dashboard.controller";

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard/advanced",  getDashboardAdv);
  app.get("/api/dashboard/executive", getDashboardExec);
  app.get("/api/dashboard/usage",     getUsageRoute);
  app.get("/api/notifications", getNotificationsRoute);
}
