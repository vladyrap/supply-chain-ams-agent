// =============================================================================
// requireAuth — Fastify preHandler que valida cookie ams_session y carga user.
// =============================================================================
// Si la cookie no existe o el user no está activo → 401.
// Inyecta `request.user` y `request.sessionId` para que los handlers (y los
// preHandlers posteriores como requirePermission) los usen.
//
// NO bloquea endpoints públicos (health, login, signup, webhooks SAP firmados).
// Esos NO deben usar este middleware.
// =============================================================================

import type { FastifyReply, FastifyRequest } from "fastify";
import { getUserBySession } from "../services/auth.service";

const COOKIE_NAME = "ams_session";

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[COOKIE_NAME];
  if (!token) {
    reply.code(401).send({ success: false, error: "Sesión requerida" });
    return;
  }
  const user = await getUserBySession(token);
  if (!user) {
    reply.code(401).send({ success: false, error: "Sesión inválida o expirada" });
    return;
  }
  // Inyectar en request (declaration merging en src/types/fastify.d.ts)
  req.user = user;
  req.sessionId = token;
}
