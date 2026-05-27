import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { logger } from "./utils/logger";
import { healthRoutes } from "./routes/health.routes";
import { amsRoutes } from "./routes/ams.routes";
import { knowledgeRoutes } from "./routes/knowledge.routes";
import { authRoutes } from "./routes/auth.routes";
import { meetingRoutes } from "./routes/meeting.routes";
import { ticketRoutes } from "./routes/ticket.routes";
import { sapRoutes } from "./routes/sap.routes";
import { supportRoutes } from "./routes/support.routes";
import { integrationRoutes } from "./routes/integration.routes";
import { dashboardRoutes } from "./routes/dashboard.routes";
import { sapInboundRoutes } from "./routes/sap-inbound.routes";
import { searchRoutes } from "./routes/search.routes";
import { evalRoutes } from "./routes/eval.routes";
import { graphRoutes } from "./routes/graph.routes";
import { demoRoutes } from "./routes/demo.routes";
import { registry, httpRequestsTotal, httpRequestDuration } from "./utils/metrics";

export function buildServer() {
  const app = Fastify({
    logger,
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 30 * 1024 * 1024,
  });

  const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
    "http://localhost:6700,http://localhost:6600,http://127.0.0.1:6700,http://127.0.0.1:6600")
    .split(",").map((s) => s.trim()).filter(Boolean);
  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
  app.register(cookie, {
    secret: process.env.COOKIE_SECRET || "ams-dev-cookie-secret-change-in-prod-please",
  });

  // Métricas Prometheus
  app.addHook("onResponse", async (req, reply) => {
    const route = (req.routeOptions?.url ?? req.url ?? "unknown").toString();
    const labels = {
      method: req.method,
      route,
      status: String(reply.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(amsRoutes);
  app.register(knowledgeRoutes);
  app.register(meetingRoutes);
  app.register(ticketRoutes);
  app.register(sapRoutes);
  app.register(supportRoutes);
  app.register(integrationRoutes);
  app.register(dashboardRoutes);
  app.register(sapInboundRoutes);
  app.register(searchRoutes);
  app.register(evalRoutes);
  app.register(graphRoutes);
  app.register(demoRoutes);

  app.setErrorHandler((err, _req, reply) => {
    logger.error({ err }, "Unhandled error");
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({
      success: false,
      error:
        status >= 500
          ? "Error procesando la solicitud del agente AMS"
          : err.message || "Bad request",
    });
  });

  return app;
}
