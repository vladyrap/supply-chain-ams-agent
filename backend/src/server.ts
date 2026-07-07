import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
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
import { memoryRoutes } from "./routes/memory.routes";
import { demoRoutes } from "./routes/demo.routes";
import { voiceRoutes } from "./routes/voice.routes";
import { agentLabRoutes } from "./routes/agent-lab.routes";
import { trainingRoutes } from "./routes/training.routes";
import { escalationRoutes } from "./routes/escalation.routes";
import { customerResponseRoutes } from "./routes/customer-response.routes";
import { testingRoutes } from "./routes/testing.routes";
import { amsModulesRoutes } from "./routes/ams-modules.routes";
import { rbacRoutes } from "./routes/rbac.routes";
// v1.2.8-prod — Admin invita usuarios reales (crea cuenta auth + email bienvenida)
import { adminUsersRoutes } from "./routes/admin-users.routes";
// v1.3 Agent Hub — agentes custom estilo IBM Consulting Advantage
import { customAgentsRoutes } from "./routes/custom-agents.routes";
// v1.3 Agent Hub — apps agénticas (pipeline multi-agente)
import { agenticAppsRoutes } from "./routes/agentic-apps.routes";
// v1.3 — Clean Core: refactor Z → Clean Core (HANA) con IA (ROCCO)
import { cleanCoreRoutes } from "./routes/clean-core.routes";
// DH v0.9 — Audit Trail backend rico
import { auditEventsRoutes } from "./routes/audit-events.routes";
// v0.12.4 — Admin usage panel (costos Gemini visibles en /admin/costs)
import { adminUsageRoutes } from "./routes/admin-usage.routes";
// v1.1.0 — SSO Google OAuth (solo activa si GOOGLE_OAUTH_CLIENT_ID seteado)
import { googleAuthRoutes } from "./routes/auth-google.routes";
// v1.1.0 — Multi-tenancy plugin
import { tenantPlugin } from "./middleware/tenant";
// v1.2.0 — Tenants CRUD (super_admin)
import { tenantsRoutes } from "./routes/tenants.routes";
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
  // v0.12.8 — Helmet: headers de seguridad recomendados (XSS, clickjacking, etc).
  // contentSecurityPolicy desactivado porque el frontend está en otro origen
  // y CSP estricta rompería los recursos cross-origin esperados.
  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  // FIX A8 (audit v1.1.0): rate limit global sin allowList por loopback.
  // Antes: ["127.0.0.1", "::1"] + trustProxy:true → spoof X-Forwarded-For: 127.0.0.1
  // bypassea rate limit. La allowList ahora es controlada por env (vacía default).
  // keyGenerator solo lee req.ip (que respeta trustProxy + última hop).
  const rlAllowList = (process.env.RATE_LIMIT_ALLOWLIST ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX_PER_MIN ?? 200),
    timeWindow: "1 minute",
    allowList: rlAllowList, // vacío por default
    skipOnError: false, // FIX: si rate-limit lib falla, mejor 503 que skip silente
    keyGenerator: (req) => req.ip ?? "unknown",
  });

  // FIX A10 (audit v1.1.0): CSRF estricto — rechazar mutations SIN Origin/Referer.
  // Antes: si no hay Origin/Referer (curl, botnet) → pass. Combo con rutas sin
  // auth = anónimo borra KB con curl. Ahora: requerir Origin O presencia en
  // CSRF_BYPASS_TOKENS env (lista de tokens HMAC para server-to-server legítimos).
  const ENFORCE_CSRF = process.env.ENFORCE_ORIGIN_CSRF !== "false"; // ON por default
  const SERVER_TO_SERVER_TOKENS = (process.env.CSRF_BYPASS_TOKENS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  // Paths que legítimamente reciben requests sin Origin (Twilio webhook, etc).
  // Toda nueva ruta server-to-server debe agregarse aquí explícitamente.
  const CSRF_BYPASS_PATHS = [
    "/api/voice/twilio/", // Twilio firma su propio request
    "/api/sap/inbound/",  // SAP webhook (puede no mandar Origin)
    "/api/memory/ingest/clean-core", // Connector Clean Core (autentica por inbound-token, sin Origin)
  ];
  if (ENFORCE_CSRF) {
    app.addHook("onRequest", async (req, reply) => {
      const method = req.method.toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
      const url = req.url;
      // Bypass por path explícito
      if (CSRF_BYPASS_PATHS.some((p) => url.startsWith(p))) return;
      // Bypass por token HMAC en header
      const csrfBypassHeader = req.headers["x-csrf-bypass"];
      if (typeof csrfBypassHeader === "string" && SERVER_TO_SERVER_TOKENS.includes(csrfBypassHeader)) {
        return;
      }
      const origin = req.headers.origin;
      const referer = req.headers.referer;
      // FIX A10: si no hay Origin/Referer Y no estamos en path/token bypass → 403.
      if (!origin && !referer) {
        reply.code(403).send({
          success: false,
          error: "Origen requerido para mutaciones (CSRF protection).",
        });
        return;
      }
      const checkAgainst = origin || (referer ? new URL(referer).origin : null);
      if (checkAgainst && !ALLOWED_ORIGINS.includes(checkAgainst)) {
        reply.code(403).send({
          success: false,
          error: "Origen no permitido (CSRF protection).",
          origin: checkAgainst,
        });
      }
    });
  }

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
  // FIX C6 (audit v1.1.0): fail-fast en prod si COOKIE_SECRET no seteada o corta.
  const COOKIE_SECRET = process.env.COOKIE_SECRET;
  if (process.env.NODE_ENV === "production") {
    if (!COOKIE_SECRET || COOKIE_SECRET.length < 32) {
      throw new Error(
        "COOKIE_SECRET required in production (>= 32 chars). Generar: openssl rand -hex 32",
      );
    }
  }
  app.register(cookie, {
    secret: COOKIE_SECRET || "ams-dev-cookie-secret-DO-NOT-USE-IN-PROD-padding-32",
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

  // FIX C1 (audit v1.1.0): tenantPlugin DEBE registrarse ANTES que cualquier
  // *Routes plugin. En Fastify, los onRequest hooks de un plugin solo se
  // ejecutan en rutas registradas en el mismo encapsulation context o después.
  // Antes estaba en línea ~203 (después de todos los routes) → req.tenantId
  // quedaba "" en TODAS las rutas de negocio → multi-tenancy no se ejecutaba.
  app.register(tenantPlugin);

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
  app.register(memoryRoutes);
  app.register(demoRoutes);
  app.register(voiceRoutes);
  app.register(agentLabRoutes);
  app.register(trainingRoutes);
  app.register(escalationRoutes);
  app.register(testingRoutes);
  app.register(amsModulesRoutes);
  app.register(rbacRoutes);
  app.register(adminUsersRoutes);
  // v1.3 Agent Hub
  app.register(customAgentsRoutes);
  app.register(agenticAppsRoutes);
  app.register(cleanCoreRoutes);
  // DH v0.9 — nuevo audit_events backend
  app.register(auditEventsRoutes);
  // v0.12.4 — admin usage / cost panel
  app.register(adminUsageRoutes);
  // v1.1.0 — SSO Google (no-op si no hay credenciales)
  app.register(googleAuthRoutes);
  // v1.2.0 — Tenants catálogo (CRUD super_admin)
  app.register(tenantsRoutes);
  app.register(scopeItemsRoutes);
  app.register(customerResponseRoutes);

  // FIX M18 (audit v1.1.0): mensajes genéricos para 4xx también.
  // Antes: 4xx devolvía err.message tal cual → leak de schema/SQL/PG codes.
  // Ahora: mapa explícito por código + fallback genérico.
  app.setErrorHandler((err, req, reply) => {
    logger.error({ err }, "Unhandled error");
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const errAny = err as { validation?: unknown; code?: string };
    if (status >= 500) {
      captureException(err, { url: req.url, method: req.method });
    }
    let safeMessage: string;
    if (status >= 500) {
      safeMessage = "Error procesando la solicitud del agente AMS";
    } else if (status === 401) {
      safeMessage = "No autorizado";
    } else if (status === 403) {
      safeMessage = "Acceso denegado";
    } else if (status === 404) {
      safeMessage = "Recurso no encontrado";
    } else if (status === 409) {
      safeMessage = "Conflicto con el estado actual del recurso";
    } else if (status === 413) {
      safeMessage = "Payload demasiado grande";
    } else if (status === 415) {
      safeMessage = "Content-Type no soportado";
    } else if (status === 429) {
      safeMessage = "Demasiadas peticiones — intentá de nuevo en unos segundos";
    } else if (errAny.validation) {
      // Errores de validación de schema Fastify son seguros de devolver.
      safeMessage = err.message;
    } else {
      // Otros 4xx: mensaje genérico (no leakear).
      safeMessage = "Petición inválida";
    }
    reply.code(status).send({ success: false, error: safeMessage });
  });

  return app;
}
