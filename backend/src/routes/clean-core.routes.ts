// =============================================================================
// clean-core.routes.ts — Refactor Z → Clean Core (HANA) con IA (ROCCO)
// =============================================================================
// Gate: agente_ams / view — es una capacidad de agente LLM (mismo permiso que
// el Agent Hub). El módulo Clean Core en el frontend ya se gatea con clean_core.
// =============================================================================

import type { FastifyInstance } from "fastify";
import { requirePermission } from "../middleware/requirePermission";
import * as ctrl from "../controllers/clean-core.controller";

export async function cleanCoreRoutes(app: FastifyInstance) {
  app.post("/api/clean-core/refactor",
    { preHandler: requirePermission("agente_ams", "view") },
    ctrl.postCleanCoreRefactor);
}
