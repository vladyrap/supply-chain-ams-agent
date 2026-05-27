import type { FastifyInstance } from "fastify";
import { getGraphRoute } from "../controllers/graph.controller";

export async function graphRoutes(app: FastifyInstance) {
  app.get("/api/graph", getGraphRoute);
}
