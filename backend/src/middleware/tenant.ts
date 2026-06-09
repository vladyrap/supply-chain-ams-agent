// =============================================================================
// tenant.ts — Multi-tenancy middleware (v1.1.1-hotfix)
// =============================================================================
// FIXES de audit v1.1.0 (C1, C2, C3, C4):
//   C1 — tenantPlugin se registra ANTES de routes (en server.ts).
//   C2 — JWT.tenantId tiene PRIORIDAD sobre header X-Tenant-Id. El header
//        solo aplica si el role del user es 'super_admin' (cross-tenant ops).
//   C3 — Eliminado el branch "DEFAULT_TENANT = sin filtro". Siempre filtrar.
//        Modo single-tenant se controla con MULTI_TENANCY_MODE env, no por
//        valor del dato.
//   C4 — Helper scopedWhere ahora devuelve {clause, params} parametrizado.
//        Eliminada la interpolación string.
//
// Resolución del tenant_id (orden de prioridad):
//   1. JWT claim (req.user.tenantId) ← FUENTE DE VERDAD
//   2. Header X-Tenant-Id solo si role === 'super_admin' (override admin)
//   3. Subdomain (acme.tudominio.cl) si MULTI_TENANCY_MODE=subdomain
//   4. DEFAULT_TENANT_ID env (fallback explícito)
// =============================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

// Modo:
//   'single'    — un solo tenant (DEFAULT_TENANT_ID), header/subdomain ignorados
//   'header'    — header X-Tenant-Id (solo super_admin) + JWT
//   'subdomain' — subdomain del host + JWT
//   'hybrid'    — todos los métodos (JWT primero)
const MODE = (process.env.MULTI_TENANCY_MODE ?? "hybrid").toLowerCase();
const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID ?? "default";
const PUBLIC_BASE_DOMAIN = (process.env.PUBLIC_BASE_DOMAIN ?? "").toLowerCase();
const TENANT_SUBDOMAIN_REGEX = /^([a-z0-9-]+)\./i;
const RESERVED_SUBDOMAINS = new Set([
  "www", "api", "app", "admin", "status", "alerts", "grafana", "prometheus",
]);

/**
 * Extrae tenant_id de la request con orden de prioridad seguro.
 * Fail-safe: siempre devuelve algo (nunca null) — en peor caso DEFAULT_TENANT.
 */
export function resolveTenantId(req: FastifyRequest): string {
  // Modo single-tenant: siempre el default, ignorar entrada del usuario.
  if (MODE === "single") return sanitize(DEFAULT_TENANT);

  // 1. JWT claim ← FUENTE DE VERDAD (verificado server-side)
  const userObj = (req as unknown as { user?: { tenantId?: string; role?: string } }).user;
  const jwtTenant = userObj?.tenantId;
  const userRole = userObj?.role;

  // 2. Header X-Tenant-Id SOLO si el user es super_admin (cross-tenant ops).
  //    Para cualquier otro role, el header se IGNORA aunque venga.
  if (MODE === "header" || MODE === "hybrid") {
    const headerTenant = req.headers["x-tenant-id"];
    if (typeof headerTenant === "string" && headerTenant.trim()) {
      if (userRole === "super_admin") {
        return sanitize(headerTenant);
      }
      // Si NO es super_admin pero mandó header → ignorar (no rechazar request).
      // Loggear para forensics si es != al JWT (intento de suplantación).
      if (jwtTenant && sanitize(headerTenant) !== sanitize(jwtTenant)) {
        req.log.warn(
          { userTenant: jwtTenant, attemptedTenant: sanitize(headerTenant), userRole },
          "tenant: header X-Tenant-Id ignorado (user no es super_admin)",
        );
      }
    }
  }

  // JWT siempre gana sobre subdomain — el subdomain solo aplica si NO hay JWT.
  if (jwtTenant && typeof jwtTenant === "string" && jwtTenant.trim()) {
    return sanitize(jwtTenant);
  }

  // 3. Subdomain (acme.PUBLIC_BASE_DOMAIN) — solo si está configurado.
  if ((MODE === "subdomain" || MODE === "hybrid") && PUBLIC_BASE_DOMAIN) {
    const host = (req.headers.host ?? "").toLowerCase();
    // Validar que el host realmente sea subdomain del dominio configurado.
    // Esto previene host header injection: "tenant.evil.com" no matchea si
    // PUBLIC_BASE_DOMAIN="tudominio.cl".
    if (host.endsWith("." + PUBLIC_BASE_DOMAIN) || host === PUBLIC_BASE_DOMAIN) {
      const m = host.match(TENANT_SUBDOMAIN_REGEX);
      if (m && m[1] && !RESERVED_SUBDOMAINS.has(m[1].toLowerCase())) {
        return sanitize(m[1]);
      }
    }
  }

  // 4. Fallback: default tenant (explícito, no es bypass).
  return sanitize(DEFAULT_TENANT);
}

function sanitize(tenant: string): string {
  return tenant.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64) || DEFAULT_TENANT;
}

/**
 * Hook que setea request.tenantId en TODAS las requests.
 * IMPORTANTE: En server.ts, registrar ANTES de los routes (fix C1).
 */
export async function tenantPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req: FastifyRequest, _reply: FastifyReply) => {
    req.tenantId = resolveTenantId(req);
  });
}

/**
 * Helper SEGURO para construir WHERE clauses tenant-scoped.
 * Devuelve {clause, params} parametrizado — NO concatena strings (fix C4).
 *
 * Uso:
 *   const { clause, params } = scopedWhere(req.tenantId, [], 1);
 *   await query(`SELECT * FROM tickets ${clause}`, params);
 *
 * Combinado con filtros extra:
 *   const { clause, params } = scopedWhere(req.tenantId, [status], 1);
 *   await query(`SELECT * FROM tickets ${clause} AND status = $${params.length}`, params);
 */
export function scopedWhere(
  tenantId: string,
  extraParams: unknown[] = [],
  startIdx = 1,
): { clause: string; params: unknown[] } {
  const safe = sanitize(tenantId);
  // SIEMPRE filtrar — no hay branch "single-tenant = sin filtro".
  // Si querés single-tenant, seteá MULTI_TENANCY_MODE=single y todos los
  // requests resolvern al mismo DEFAULT_TENANT, pero el WHERE se aplica igual.
  return {
    clause: `WHERE tenant_id = $${startIdx}`,
    params: [safe, ...extraParams],
  };
}

/** AND clause para combinar con WHEREs existentes. */
export function scopedAnd(
  tenantId: string,
  paramIdx: number,
): { clause: string; param: string } {
  return { clause: `tenant_id = $${paramIdx}`, param: sanitize(tenantId) };
}
