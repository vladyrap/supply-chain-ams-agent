import Fastify from "fastify";
import cors from "@fastify/cors";
import { initSentry, captureException } from "./utils/sentry";

// Inicializa Sentry ANTES de Fastify (recomendado).
initSentry();
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import { logger } from "./utils/logger";
import { healthRoutes } from "./routes/health.routes";
import { amsRoutes } from "./routes/ams.routes";
import { knowledgeRoutes } from "./routes/knowledge.routes";
import { authRoutes } from "./routes/auth.routes";
import { meetingRoutes } from "./routes/meeting.routes";
import { ticketRoutes } from "./routes/ticket.routes";
import { scopeItemsRoutes } from "./routes/scope-items.routes";
import { sapRoutes } from "./routes/sap.routes";
import { supportRoutes } from "./routes/support.routes";
import { integrationRoutes } from "./routes/integration.routes";
import { dashboardRoutes } from "./routes/dashboard.routes";
import { sapInboundRoutes } from "./routes/sap-inbound.routes";
import { searchRoutes } from "./routes/search.routes";
import { evalRoutes } from "./routes/eval.routes";
import { graphRoutes } from "./routes/graph.routes";
import { demoRoutes } from "./routes/demo.routes";
import { voiceRoutes } from "./routes/voice.routes";
import { agentLabRoutes } from "./routes/agent-lab.routes";
import { trainingRoutes } from "./routes/training.routes";
import { escalationRoutes } from "./routes/escalation.routes";
import { customerResponseRoutes } from "./routes/customer-response.routes";
import { testingRoutes } from "./routes/testing.routes";
import { amsModulesRoutes } from "./routes/ams-modules.routes";
import { rbacRoutes } from "./routes/rbac.routes";
// DH v0.9 — Audit Trail backend rico
import { auditEventsRoutes } from "./routes/audit-events.routes";
// v0.12.4 — Admin usage panel (costos Gemini visibles en /admin/costs)
import { adminUsageRoutes } from "./routes/admin-usage.routes";
import { registry, httpRequestsTotal, httpRequestDuration } from "./utils/metrics";

export function buildServer() {
  const app = Fastify({
    logger,
    disableRequestLogging: false,
    trustProxy: true,
    bodyLimit: 30 * 1024 * 1024,
  });

  // v0.12.7 — Fix BUG-001: Fastify por default rechaza con 400 cualquier request
  // con Content-Type: application/json y body vacio. Eso rompe llamadas legitimas
  // de DELETE/POST sin payload, que el frontend a veces emite con el header pero
  // sin body. Reemplazamos el parser para devolver objeto vacio en esos casos.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const raw = (body as string | Buffer | undefined) ?? "";
      const text = typeof raw === "string" ? raw : raw.toString("utf-8");
      if (text.trim() === "") {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        const wrapped = err as Error & { statusCode?: number };
        wrapped.statusCode = 400;
        done(wrapped, undefined);
      }
    },
  );

  const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS ||
    "http://localhost:6700,http://localhost:6600,http://127.0.0.1:6700,http://127.0.0.1:6600")
    .split(",").map((s) => s.trim()).filter(Boolean);
  app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
    // v0.12.2 — agregado PUT para /api/tickets/:key/intelligence (AIE pipeline).
    // El frontend hace PUT en useAutoEnrichment cuando persiste resultado del analisis.
    // Sin PUT en CORS, el preflight rechaza con "Method PUT is not allowed".
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  app.register(cookie, {
    secret: process.env.COOKIE_SECRET || "ams-dev-cookie-secret-change-in-prod-please",
  });

  // Twilio webhooks usan application/x-www-form-urlencoded.
  // Sin este parser, req.body llega vacío en /api/voice/*.
  app.register(formbody);

  // Multipart para upload de videos (Testing Intelligence).
  // Limit 100MB por archivo. Si necesitás más, ajustar fileSize.
  app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024, // 100 MB
      files: 1,
    },
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
  app.register(voiceRoutes);
  app.register(agentLabRoutes);
  app.register(trainingRoutes);
  app.register(escalationRoutes);
  app.register(testingRoutes);
  app.register(amsModulesRoutes);
  app.register(rbacRoutes);
  // DH v0.9 — nuevo audit_events backend
  app.register(auditEventsRoutes);
  // v0.12.4 — admin usage / cost panel
  app.register(adminUsageRoutes);
  app.register(scopeItemsRoutes);
  app.register(customerResponseRoutes);

  app.setErrorHandler((err, req, reply) => {
    logger.error({ err }, "Unhandled error");
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // Sólo reportar a Sentry los 5xx (los 4xx son ruido).
    if (status >= 500) {
      captureException(err, { url: req.url, method: req.method });
    }
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
