import type { FastifyInstance } from "fastify";
import { ping } from "../database/db";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    return reply.send({
      success: true,
      service: "ams-backend",
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/health/deep", async (_req, reply) => {
    const dbOk = await ping();
    return reply.send({
      success: dbOk,
      service: "ams-backend",
      status: dbOk ? "ok" : "degraded",
      checks: { db: dbOk ? "ok" : "down" },
      timestamp: new Date().toISOString(),
    });
  });
}
