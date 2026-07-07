import type { FastifyInstance } from "fastify";
import {
  listMemoryRoute, getMemoryRoute, ingestMemoryRoute,
} from "../controllers/memory.controller";
import { requirePermission } from "../middleware/requirePermission";

export async function memoryRoutes(app: FastifyInstance) {
  // Lectura de la Memoria Organizacional (scoped al tenant vía req.tenantId).
  app.get("/api/memory", listMemoryRoute);
  app.get("/api/memory/:id", getMemoryRoute);
  // Ingesta idempotente (tickets resueltos → memoria). Acción de configuración.
  app.post("/api/memory/ingest", { preHandler: requirePermission("conocimiento_rag", "configure") }, ingestMemoryRoute);
}
