import type { FastifyRequest, FastifyReply } from "fastify";
import {
  createUser,
  findUserByEmail,
  verifyPassword,
  createSession,
  getUserBySession,
  deleteSession,
  listUsers,
  updateUserRole,
} from "../services/auth.service";
import { logger } from "../utils/logger";
import type { Role } from "../types/auth.types";

const COOKIE_NAME = "ams_session";
const isProduction = process.env.NODE_ENV === "production";

function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 30 * 24 * 60 * 60, // 30 días
  });
}
function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

export async function postSignup(
  req: FastifyRequest<{ Body: { email?: string; password?: string; name?: string; role?: Role } }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.email || !b.password) {
    return reply.code(400).send({ success: false, error: "email y password son obligatorios" });
  }
  try {
    const existing = await findUserByEmail(b.email);
    if (existing) {
      return reply.code(409).send({ success: false, error: "Ya existe un usuario con ese email" });
    }
    // SEGURIDAD: solo permitir role="admin" si no hay usuarios todavía (primer signup queda admin).
    // Para roles distintos del default, solo un admin (autenticado) podrá cambiar el rol.
    const allUsers = await listUsers();
    const requestedRole: Role = b.role === "admin" || b.role === "aprobador" || b.role === "viewer"
      ? b.role
      : "consultor";
    // Bootstrap: si NO hay usuarios y el primero pide admin, lo aceptamos.
    const safeRole: Role = allUsers.length === 0 ? "admin" : (requestedRole === "admin" ? "consultor" : requestedRole);
    const user = await createUser({
      email: b.email,
      password: b.password,
      name: b.name,
      role: safeRole,
    });
    const token = await createSession(user.id, req.headers["user-agent"] || undefined);
    setSessionCookie(reply, token);
    return reply.send({ success: true, user });
  } catch (err) {
    logger.error({ err }, "Fallo en /api/auth/signup");
    return reply.code(400).send({
      success: false,
      error: err instanceof Error ? err.message : "Error creando usuario",
    });
  }
}

export async function postLogin(
  req: FastifyRequest<{ Body: { email?: string; password?: string } }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.email || !b.password) {
    return reply.code(400).send({ success: false, error: "email y password son obligatorios" });
  }
  try {
    const user = await findUserByEmail(b.email);
    if (!user || !user.active) {
      return reply.code(401).send({ success: false, error: "Credenciales inválidas" });
    }
    const ok = await verifyPassword(b.password, user.password_hash);
    if (!ok) {
      return reply.code(401).send({ success: false, error: "Credenciales inválidas" });
    }
    const token = await createSession(user.id, req.headers["user-agent"] || undefined);
    setSessionCookie(reply, token);
    // No devolver password_hash
    const { password_hash: _ph, ...safe } = user;
    return reply.send({ success: true, user: safe });
  } catch (err) {
    logger.error({ err }, "Fallo en /api/auth/login");
    return reply.code(500).send({ success: false, error: "Error procesando login" });
  }
}

export async function postLogout(req: FastifyRequest, reply: FastifyReply) {
  const token = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (token) await deleteSession(token);
  clearSessionCookie(reply);
  return reply.send({ success: true });
}

export async function getMe(req: FastifyRequest, reply: FastifyReply) {
  const token = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!token) {
    return reply.code(401).send({ success: false, error: "no_session" });
  }
  const user = await getUserBySession(token);
  if (!user) {
    clearSessionCookie(reply);
    return reply.code(401).send({ success: false, error: "invalid_session" });
  }
  return reply.send({ success: true, user });
}

// === Admin only: list users, change role ===
async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  const token = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!token) {
    reply.code(401).send({ success: false, error: "no_session" });
    return null;
  }
  const user = await getUserBySession(token);
  if (!user) {
    reply.code(401).send({ success: false, error: "invalid_session" });
    return null;
  }
  if (user.role !== "admin") {
    reply.code(403).send({ success: false, error: "requiere rol admin" });
    return null;
  }
  return user;
}

export async function getUsers(req: FastifyRequest, reply: FastifyReply) {
  const me = await requireAdmin(req, reply);
  if (!me) return;
  const users = await listUsers();
  return reply.send({ success: true, count: users.length, users });
}

export async function patchUserRole(
  req: FastifyRequest<{ Params: { id: string }; Body: { role?: Role } }>,
  reply: FastifyReply
) {
  const me = await requireAdmin(req, reply);
  if (!me) return;
  const newRole = req.body?.role;
  if (!newRole) {
    return reply.code(400).send({ success: false, error: "role es obligatorio" });
  }
  try {
    const updated = await updateUserRole(req.params.id, newRole);
    if (!updated) return reply.code(404).send({ success: false, error: "usuario no encontrado" });
    return reply.send({ success: true, user: updated });
  } catch (err) {
    return reply.code(400).send({
      success: false,
      error: err instanceof Error ? err.message : "Error",
    });
  }
}
