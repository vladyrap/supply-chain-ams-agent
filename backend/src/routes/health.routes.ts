import type { FastifyInstance } from "fastify";
import { ping } from "../database/db";
import { getGeminiRateLimitStats } from "../utils/gemini-rate-limiter";

const BOOT_TIME = Date.now();

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

  // v0.12.10 — Status endpoint detallado para monitoreo externo + status page.
  // Devuelve resumen completo del estado del sistema. Público (sin auth) pero
  // sin info sensible (solo health booleans + counts agregados).
  app.get("/api/status", async (_req, reply) => {
    const dbOk = await ping();
    const rl = getGeminiRateLimitStats();
    const uptimeSec = Math.floor((Date.now() - BOOT_TIME) / 1000);
    const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

    const checks = {
      backend: { status: "up", uptimeSec, memoryMb: memMb },
      database: { status: dbOk ? "up" : "down" },
      geminiRateLimiter: {
        status: rl.enabled ? "enforcing" : "disabled",
        capDay: rl.caps.day,
        usedDay: rl.current.day,
        utilizationPct: rl.caps.day > 0 ? Math.round((rl.current.day / rl.caps.day) * 100) : 0,
      },
    };

    // Status overall: down si DB down, degraded si rate limiter > 90%, up si todo OK
    let overallStatus: "up" | "degraded" | "down" = "up";
    if (!dbOk) overallStatus = "down";
    else if (checks.geminiRateLimiter.utilizationPct > 90) overallStatus = "degraded";

    return reply.send({
      status: overallStatus,
      service: "ams-backend",
      version: process.env.APP_VERSION || "dev",
      environment: process.env.NODE_ENV || "development",
      timestamp: new Date().toISOString(),
      checks,
    });
  });
}
