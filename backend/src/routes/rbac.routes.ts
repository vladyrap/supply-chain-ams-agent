import type { FastifyInstance } from "fastify";
import * as ctrl from "../controllers/rbac.controller";

export async function rbacRoutes(app: FastifyInstance) {
  app.get("/api/rbac/snapshot", ctrl.getSnapshot);
  app.post("/api/rbac/roles", ctrl.upsertRole);
  app.delete<{ Params: { id: string } }>("/api/rbac/roles/:id", ctrl.deleteRole);
  app.post("/api/rbac/users", ctrl.upsertUser);
  app.delete<{ Params: { id: string } }>("/api/rbac/users/:id", ctrl.deleteUser);
  app.post("/api/rbac/reset-demo", ctrl.postResetDemo);
}
