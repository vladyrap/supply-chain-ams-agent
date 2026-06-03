import type { FastifyInstance } from "fastify";
import {
  getStatus,
  getPos,
  getPoDetail,
  getSos,
  getSoDetail,
  getMaterials,
  getMaterialDetail,
  getMovements,
} from "../controllers/sap.controller";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function sapRoutes(app: FastifyInstance) {
  // Todas las lecturas SAP requieren view sobre modulos_sap
  app.get("/api/sap/status",
    { preHandler: requirePermission("modulos_sap", "view") },
    getStatus);

  // Purchasing
  app.get("/api/sap/purchase-orders",
    { preHandler: requirePermission("modulos_sap", "view") },
    getPos as never);
  app.get<{ Params: { id: string } }>("/api/sap/purchase-orders/:id",
    { preHandler: requirePermission("modulos_sap", "view") },
    getPoDetail);

  // Sales
  app.get("/api/sap/sales-orders",
    { preHandler: requirePermission("modulos_sap", "view") },
    getSos);
  app.get<{ Params: { id: string } }>("/api/sap/sales-orders/:id",
    { preHandler: requirePermission("modulos_sap", "view") },
    getSoDetail);

  // Materials
  app.get("/api/sap/materials",
    { preHandler: requirePermission("modulos_sap", "view") },
    getMaterials as never);
  app.get<{ Params: { matnr: string } }>("/api/sap/materials/:matnr",
    { preHandler: requirePermission("modulos_sap", "view") },
    getMaterialDetail);

  // Movements
  app.get("/api/sap/movements",
    { preHandler: requirePermission("modulos_sap", "view") },
    getMovements as never);
}
