import type { FastifyInstance } from "fastify";
import {
  postSignup,
  postLogin,
  postLogout,
  getMe,
  getUsers,
  patchUserRole,
} from "../controllers/auth.controller";
import type { Role } from "../types/auth.types";

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/signup", postSignup);
  app.post("/api/auth/login", postLogin);
  app.post("/api/auth/logout", postLogout);
  app.get("/api/auth/me", getMe);
  app.get("/api/auth/users", getUsers);
  app.patch<{ Params: { id: string }; Body: { role?: Role } }>(
    "/api/auth/users/:id/role",
    patchUserRole
  );
}
