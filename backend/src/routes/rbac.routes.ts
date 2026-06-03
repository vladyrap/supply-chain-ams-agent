import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/rbac.controller";
// DH v0.9 — RBAC backend enforcement
import { requirePermission } from "../middleware/requirePermission";

export async function rbacRoutes(app: FastifyInstance) {
  // Snapshot: requiere ver administracion (los users normales no necesitan)
  app.get("/api/rbac/snapshot",
    { preHandler: requirePermission("administracion", "view") },
    ctrl.getSnapshot);
  // CRUD de roles y users: configure sobre administracion (solo ADMIN/SERVICE_LEAD)
  app.post("/api/rbac/roles",
    { preHandler: requirePermission("administracion", "configure") },
    ctrl.upsertRole as never);
  app.delete<{ Params: { id: string } }>("/api/rbac/roles/:id",
    { preHandler: requirePermission("administracion", "configure") },
    ctrl.deleteRole);
  app.post("/api/rbac/users",
    { preHandler: requirePermission("administracion", "configure") },
    ctrl.upsertUser as never);
  app.delete<{ Params: { id: string } }>("/api/rbac/users/:id",
    { preHandler: requirePermission("administracion", "configure") },
    ctrl.deleteUser);
  app.post("/api/rbac/reset-demo",
    { preHandler: requirePermission("administracion", "configure") },
    ctrl.postResetDemo);
}
