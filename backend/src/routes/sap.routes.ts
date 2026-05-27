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

export async function sapRoutes(app: FastifyInstance) {
  app.get("/api/sap/status", getStatus);

  // Purchasing
  app.get("/api/sap/purchase-orders", getPos);
  app.get<{ Params: { id: string } }>("/api/sap/purchase-orders/:id", getPoDetail);

  // Sales
  app.get("/api/sap/sales-orders", getSos);
  app.get<{ Params: { id: string } }>("/api/sap/sales-orders/:id", getSoDetail);

  // Materials
  app.get("/api/sap/materials", getMaterials);
  app.get<{ Params: { matnr: string } }>("/api/sap/materials/:matnr", getMaterialDetail);

  // Movements
  app.get("/api/sap/movements", getMovements);
}
