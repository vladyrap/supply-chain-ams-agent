import type { FastifyInstance } from "fastify";
import { streamDemoRun } from "../controllers/demo.controller";

export async function demoRoutes(app: FastifyInstance) {
  // GET para que un EventSource del browser pueda conectarse directamente.
  app.get("/api/demo/run", streamDemoRun);
}
