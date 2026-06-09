// =============================================================================
// tenant.ts — Multi-tenancy middleware (v0.13)
// =============================================================================
// Resuelve el tenant_id desde:
//   1. Header X-Tenant-Id (más explícito, recomendado para APIs)
//   2. Subdomain (acme.tuempresa.cl → tenant 'acme')
//   3. JWT claim del user logueado
//   4. Fallback: 'default' (compat con código actual)
//
// Expone request.tenantId tipado para downstream handlers.
// Helper: scopedQuery(tenantId, ...) para queries que filtran por tenant.
// =============================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID ?? "default";
const TENANT_SUBDOMAIN_REGEX = /^([a-z0-9-]+)\./i;

/** Extrae tenant_id de la request. Cae a DEFAULT_TENANT si nada match. */
export function resolveTenantId(req: FastifyRequest): string {
  // 1. Header explícito
  const headerTenant = req.headers["x-tenant-id"];
  if (typeof headerTenant === "string" && headerTenant.trim()) {
    return sanitize(headerTenant);
  }
  // 2. Subdomain (acme.tuempresa.cl)
  const host = req.headers.host;
  if (host) {
    const m = host.match(TENANT_SUBDOMAIN_REGEX);
    if (m && m[1] && !["www", "api", "app", "admin", "status"].includes(m[1].toLowerCase())) {
      return sanitize(m[1]);
    }
  }
  // 3. JWT claim (si auth está activo y agregó user al request)
  // @ts-expect-error - user es definido por auth plugin
  const userTenant = req.user?.tenantId;
  if (typeof userTenant === "string" && userTenant.trim()) {
    return sanitize(userTenant);
  }
  // 4. Default
  return DEFAULT_TENANT;
}

function sanitize(tenant: string): string {
  return tenant.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
}

/**
 * Hook que setea request.tenantId en TODAS las requests.
 * Registrar en server.ts con: app.register(tenantPlugin)
 */
export async function tenantPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req: FastifyRequest, _reply: FastifyReply) => {
    req.tenantId = resolveTenantId(req);
  });
}

/**
 * Helper para construir WHERE clauses tenant-scoped.
 * Uso:
 *   const { rows } = await query(
 *     `SELECT * FROM tickets ${scopedWhere(req.tenantId)}`,
 *     [...]
 *   );
 * O en queries con parámetros adicionales:
 *   const { rows } = await query(
 *     `SELECT * FROM tickets WHERE tenant_id = $1 AND status = $2`,
 *     [req.tenantId, status]
 *   );
 */
export function scopedWhere(tenantId: string): string {
  if (!tenantId || tenantId === DEFAULT_TENANT) {
    // Modo single-tenant: no agregar filtro (backward compatible)
    return "";
  }
  // Multi-tenant: agregar filtro. NOTA: para safety usar parámetros, no interpolación.
  return `WHERE tenant_id = '${tenantId.replace(/'/g, "''")}'`;
}
