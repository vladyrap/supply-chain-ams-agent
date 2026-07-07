import type { FastifyInstance } from "fastify";
import {
  listMemoryRoute, getMemoryRoute, ingestMemoryRoute, ingestCleanCoreRoute,
} from "../controllers/memory.controller";
import { requirePermission } from "../middleware/requirePermission";

export async function memoryRoutes(app: FastifyInstance) {
  // Lectura de la Memoria Organizacional (scoped al tenant vía req.tenantId).
  app.get("/api/memory", listMemoryRoute);
  app.get("/api/memory/:id", getMemoryRoute);
  // Ingesta idempotente (tickets resueltos → memoria). Acción de configuración.
  app.post("/api/memory/ingest", { preHandler: requirePermission("conocimiento_rag", "configure") }, ingestMemoryRoute);
  // Ingesta de hallazgos Clean Core (SAP-técnicos) → grafo + memoria. Fase 2.
  app.post("/api/memory/ingest/clean-core", { preHandler: requirePermission("modulos_sap", "configure") }, ingestCleanCoreRoute);
}
