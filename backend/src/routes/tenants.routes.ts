// =============================================================================
// tenants.routes.ts — CRUD de tenants (v1.2.0 multi-tenant)
// =============================================================================
// SUPER_ADMIN-ONLY salvo GET /me que devuelve el tenant del usuario actual.
//
// Endpoints:
//   GET    /api/tenants/me        → tenant del request (cualquier user autenticado)
//   GET    /api/tenants           → listar todos (super_admin)
//   GET    /api/tenants/:id       → detalle (super_admin)
//   POST   /api/tenants           → crear (super_admin)
//   PATCH  /api/tenants/:id       → actualizar (super_admin O admin del tenant para brand/settings)
//   DELETE /api/tenants/:id       → soft delete (super_admin)
// =============================================================================

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  listTenants, getTenant, createTenant, updateTenant, softDeleteTenant,
  type CreateTenantInput, type UpdateTenantInput,
} from "../services/tenants.service";
import { requireAuth } from "../middleware/requireAuth";
import { getUserBySession } from "../services/auth.service";
import { logger } from "../utils/logger";

/** Super admin = role='admin' Y tenantId del request es '*' (multi-tenant view) o admin del default. */
function isSuperAdmin(req: FastifyRequest): boolean {
  const role = (req.user?.role as string) || "";
  // En v1.2.0: super_admin se reconoce por role='admin' del tenant 'default' (o future tenant 'system').
  // En el futuro se puede agregar role='super_admin' explícito en RBAC.
  return role === "admin" && (req.tenantId === "default" || req.tenantId === "*");
}

/** Admin del tenant = role='admin' Y tenantId match. */
function isTenantAdmin(req: FastifyRequest, tenantId: string): boolean {
  const role = (req.user?.role as string) || "";
  return role === "admin" && req.tenantId === tenantId;
}

export async function tenantsRoutes(app: FastifyInstance): Promise<void> {

  // -------------------------------------------------------------------
  // GET /api/tenants/me — tenant del request actual
  // Onda 7.2: es un PROBE (TenantProvider lo llama en cada carga, también
  // en /login sin sesión). Sin sesión → 200 {success:false} en vez de 401
  // para no ensuciar la consola del browser. Endpoints protegidos reales
  // siguen usando requireAuth con 401.
  // -------------------------------------------------------------------
  app.get(
    "/api/tenants/me",
    async (req, reply) => {
      try {
        const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
        const token = cookies?.["ams_session"];
        const user = token ? await getUserBySession(req.tenantId, token) : null;
        if (!user) {
          return reply.send({ success: false, error: "no_session" });
        }
        const tenant = await getTenant(req.tenantId);
        if (!tenant) {
          return reply.code(404).send({
            success: false,
            error: `Tenant '${req.tenantId}' no encontrado o suspendido.`,
          });
        }
        return reply.send({ success: true, tenant });
      } catch (err) {
        logger.error({ err }, "GET /tenants/me failed");
        return reply.code(500).send({ success: false, error: "Error obteniendo tenant" });
      }
    },
  );

  // -------------------------------------------------------------------
  // GET /api/tenants — listar todos (super_admin)
  // -------------------------------------------------------------------
  app.get<{ Querystring: { includeDeleted?: string } }>(
    "/api/tenants",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isSuperAdmin(req)) {
        return reply.code(403).send({ success: false, error: "Requiere super_admin" });
      }
      try {
        const includeDeleted = req.query.includeDeleted === "true";
        const tenants = await listTenants({ includeDeleted });
        return reply.send({ success: true, tenants, count: tenants.length });
      } catch (err) {
        logger.error({ err }, "GET /tenants failed");
        return reply.code(500).send({ success: false, error: "Error listando tenants" });
      }
    },
  );

  // -------------------------------------------------------------------
  // GET /api/tenants/:id — detalle
  // -------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/api/tenants/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      // Permitir: super_admin O admin del mismo tenant que se está consultando
      if (!isSuperAdmin(req) && !isTenantAdmin(req, req.params.id)) {
        return reply.code(403).send({ success: false, error: "Sin acceso a este tenant" });
      }
      try {
        const tenant = await getTenant(req.params.id);
        if (!tenant) {
          return reply.code(404).send({ success: false, error: "Tenant no encontrado" });
        }
        return reply.send({ success: true, tenant });
      } catch (err) {
        logger.error({ err, id: req.params.id }, "GET /tenants/:id failed");
        return reply.code(500).send({ success: false, error: "Error obteniendo tenant" });
      }
    },
  );

  // -------------------------------------------------------------------
  // POST /api/tenants — crear (super_admin only)
  // -------------------------------------------------------------------
  app.post<{ Body: CreateTenantInput }>(
    "/api/tenants",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["id", "name"],
          properties: {
            id: { type: "string", minLength: 3, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$" },
            name: { type: "string", minLength: 2, maxLength: 120 },
            subdomain: { type: "string", maxLength: 64 },
            plan: { type: "string", enum: ["starter", "standard", "premium", "enterprise"] },
            status: { type: "string", enum: ["active", "trial", "suspended"] },
            brand: { type: "object", additionalProperties: true },
            settings: { type: "object", additionalProperties: true },
            monthlyQuotaTickets: { type: "integer", minimum: 0 },
            monthlyQuotaGeminiUsd: { type: "number", minimum: 0 },
            trialEndsAt: { type: "string", format: "date-time" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req: FastifyRequest<{ Body: CreateTenantInput }>, reply: FastifyReply) => {
      if (!isSuperAdmin(req)) {
        return reply.code(403).send({ success: false, error: "Requiere super_admin" });
      }
      try {
        const tenant = await createTenant(req.body);
        return reply.code(201).send({ success: true, tenant });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("ya existe") || msg.includes("inválido")) {
          return reply.code(400).send({ success: false, error: msg });
        }
        logger.error({ err }, "POST /tenants failed");
        return reply.code(500).send({ success: false, error: "Error creando tenant" });
      }
    },
  );

  // -------------------------------------------------------------------
  // PATCH /api/tenants/:id — update parcial
  // -------------------------------------------------------------------
  app.patch<{ Params: { id: string }; Body: UpdateTenantInput }>(
    "/api/tenants/:id",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 2, maxLength: 120 },
            subdomain: { type: "string", maxLength: 64 },
            plan: { type: "string", enum: ["starter", "standard", "premium", "enterprise"] },
            status: { type: "string", enum: ["active", "trial", "suspended", "deleted"] },
            brand: { type: "object", additionalProperties: true },
            settings: { type: "object", additionalProperties: true },
            monthlyQuotaTickets: { type: ["integer", "null"], minimum: 0 },
            monthlyQuotaGeminiUsd: { type: ["number", "null"], minimum: 0 },
            trialEndsAt: { type: ["string", "null"], format: "date-time" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const superAdmin = isSuperAdmin(req);
      const tenantAdmin = isTenantAdmin(req, id);
      if (!superAdmin && !tenantAdmin) {
        return reply.code(403).send({ success: false, error: "Sin acceso a este tenant" });
      }
      // Tenant admin (no super) solo puede tocar brand + settings (no plan/status/quotas/subdomain)
      if (tenantAdmin && !superAdmin) {
        const allowed = ["brand", "settings", "name"];
        const blocked = Object.keys(req.body).filter((k) => !allowed.includes(k));
        if (blocked.length) {
          return reply.code(403).send({
            success: false,
            error: `Solo super_admin puede modificar: ${blocked.join(", ")}`,
          });
        }
      }
      try {
        const tenant = await updateTenant(id, req.body);
        if (!tenant) {
          return reply.code(404).send({ success: false, error: "Tenant no encontrado" });
        }
        return reply.send({ success: true, tenant });
      } catch (err) {
        logger.error({ err, id }, "PATCH /tenants/:id failed");
        return reply.code(500).send({ success: false, error: "Error actualizando tenant" });
      }
    },
  );

  // -------------------------------------------------------------------
  // DELETE /api/tenants/:id — soft delete (super_admin)
  // -------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/api/tenants/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isSuperAdmin(req)) {
        return reply.code(403).send({ success: false, error: "Requiere super_admin" });
      }
      try {
        const deleted = await softDeleteTenant(req.params.id);
        if (!deleted) {
          return reply.code(404).send({ success: false, error: "Tenant no encontrado o ya borrado" });
        }
        return reply.send({ success: true, tenantId: req.params.id, status: "deleted" });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("default")) {
          return reply.code(400).send({ success: false, error: msg });
        }
        logger.error({ err, id: req.params.id }, "DELETE /tenants/:id failed");
        return reply.code(500).send({ success: false, error: "Error borrando tenant" });
      }
    },
  );
}
