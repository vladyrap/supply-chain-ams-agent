import type { FastifyInstance } from "fastify";
import {
  postSignup,
  postLogin,
  postLogout,
  postRefresh,
  getSessions,
  postLogoutAll,
  getMe,
  getUsers,
  patchUserRole,
} from "../controllers/auth.controller";
import type { Role } from "../types/auth.types";

// =============================================================================
// FIX A9 (audit v1.1.0): rate limit DEDICADO + estricto para login/signup/reset.
// El rate limit global (200/min/IP) es brute-forceable. Endpoints sensibles
// quedan en 8/min/IP por endpoint con allowList vacía (no skip por loopback).
// =============================================================================
const AUTH_STRICT_RL = {
  config: {
    rateLimit: {
      max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 8),
      timeWindow: process.env.AUTH_RATE_LIMIT_WINDOW ?? "1 minute",
      // No skip por allowList — login no debe tener trust list.
      allowList: [] as string[],
    },
  },
};

export async function authRoutes(app: FastifyInstance) {
  // FIX A9: rate limit dedicado en endpoints sensibles.
  app.post("/api/auth/signup", AUTH_STRICT_RL, postSignup);
  app.post("/api/auth/login", AUTH_STRICT_RL, postLogin);
  app.post("/api/auth/refresh", AUTH_STRICT_RL, postRefresh);

  app.post("/api/auth/logout", postLogout);
  app.get("/api/auth/sessions", getSessions);
  app.post("/api/auth/logout-all", postLogoutAll);
  app.get("/api/auth/me", getMe);
  app.get("/api/auth/users", getUsers);
  app.patch<{ Params: { id: string }; Body: { role?: Role } }>(
    "/api/auth/users/:id/role",
    patchUserRole
  );
}
