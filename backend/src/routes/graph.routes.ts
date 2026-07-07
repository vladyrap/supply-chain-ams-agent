import type { FastifyInstance } from "fastify";
import {
  getGraphRoute, getPersistedGraphRoute, rebuildGraphRoute,
} from "../controllers/graph.controller";
import { requirePermission } from "../middleware/requirePermission";

export async function graphRoutes(app: FastifyInstance) {
  // Proyección en vivo (comportamiento existente, sin cambios).
  app.get("/api/graph", getGraphRoute);
  // Grafo persistido (ROCCO Fase 0). Lectura: mismo scope que la proyección.
  app.get("/api/graph/persisted", getPersistedGraphRoute);
  // Rebuild: acción de recomputo → gateada por RBAC (screen reportes / configure).
  app.post("/api/graph/rebuild", { preHandler: requirePermission("reportes", "configure") }, rebuildGraphRoute);
}
