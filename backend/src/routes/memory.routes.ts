import type { FastifyInstance } from "fastify";
import {
  listMemoryRoute, getMemoryRoute, ingestMemoryRoute, ingestCleanCoreRoute,
  searchMemoryRoute, recordDecisionRoute, exportMemoryRoute, statsMemoryRoute,
} from "../controllers/memory.controller";
import { requirePermission } from "../middleware/requirePermission";

export async function memoryRoutes(app: FastifyInstance) {
  // Lectura de la Memoria Organizacional (scoped al tenant vía req.tenantId).
  app.get("/api/memory", listMemoryRoute);
  // Recuperación híbrida (memoria léxica + expansión por grafo). Fase 3.
  // Rutas estáticas antes de la paramétrica /:id (Fastify prioriza estáticas de todos modos).
  app.get("/api/memory/search", searchMemoryRoute);
  app.get("/api/memory/stats", statsMemoryRoute);
  // Exportación de memoria + grafo (portabilidad — la IA es reemplazable). Fase 4.
  app.get("/api/memory/export", { preHandler: requirePermission("conocimiento_rag", "export") }, exportMemoryRoute);
  app.get("/api/memory/:id", getMemoryRoute);
  // Ingesta idempotente (tickets resueltos → memoria). Acción de configuración.
  app.post("/api/memory/ingest", { preHandler: requirePermission("conocimiento_rag", "configure") }, ingestMemoryRoute);
  // Ingesta de hallazgos Clean Core (SAP-técnicos) → grafo + memoria. Fase 2.
  app.post("/api/memory/ingest/clean-core", { preHandler: requirePermission("modulos_sap", "configure") }, ingestCleanCoreRoute);
  // Registro de decisiones (IA propone, consultor decide — Art. 8). Fase 4.
  app.post("/api/memory/decision", { preHandler: requirePermission("conocimiento_rag", "create") }, recordDecisionRoute);
}
