import type { FastifyRequest, FastifyReply } from "fastify";
import {
  createUser,
  findUserByEmail,
  verifyPassword,
  createSessionWithRefresh,
  rotateRefreshToken,
  revokeAllSessions,
  listUserSessions,
  recordAuthEvent,
  getUserBySession,
  deleteSession,
  listUsers,
  updateUserRole,
  createPasswordResetToken,
  validatePasswordResetToken,
  resetPasswordWithToken,
} from "../services/auth.service";
import { sendPasswordReset } from "../services/email.service";
import { logger } from "../utils/logger";
import type { Role } from "../types/auth.types";

const COOKIE_NAME = "ams_session";
const REFRESH_COOKIE_NAME = "ams_refresh";
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
function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE_NAME, token, {
    path: "/api/auth",       // sólo accesible a endpoints de auth (defensa en profundidad)
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 60 * 24 * 60 * 60, // 60 días
  });
}
function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE_NAME, { path: "/api/auth" });
}

function meta(req: FastifyRequest) {
  return {
    userAgent: req.headers["user-agent"] || undefined,
    ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip,
  };
}

// FIX C5 (audit v1.1.0): signup público gated por env.
// En prod, ENABLE_PUBLIC_SIGNUP debe ser explícitamente "true" para permitir
// signup desde el form. Si está apagado, retorna 403 y obliga a usar seed CLI
// o invite-flow. Esto cierra la escalada de privilegios via race condition
// del "primer usuario = admin".
const SIGNUP_ENABLED = process.env.ENABLE_PUBLIC_SIGNUP === "true";

export async function postSignup(
  req: FastifyRequest<{ Body: { email?: string; password?: string; name?: string; role?: Role } }>,
  reply: FastifyReply
) {
  // FIX C5: en prod, signup desactivado por default.
  if (!SIGNUP_ENABLED) {
    return reply.code(403).send({
      success: false,
      error: "Signup público desactivado. Contactá al admin para crear cuenta.",
    });
  }
  const b = req.body || {};
  if (!b.email || !b.password) {
    return reply.code(400).send({ success: false, error: "email y password son obligatorios" });
  }
  try {
    const existing = await findUserByEmail(req.tenantId, b.email);
    if (existing) {
      return reply.code(409).send({ success: false, error: "Ya existe un usuario con ese email" });
    }
    // FIX C5: NUNCA aceptar role=admin desde el body. El primer-user-bootstrap
    // se hace por seed CLI o por env BOOTSTRAP_ADMIN_EMAIL/PASSWORD al boot,
    // no via HTTP. Si el operador necesita un admin de emergencia, debe usar
    // el script database/seeds/bootstrap-admin.ts.
    // Todo signup nuevo arranca como "consultor".
    const safeRole: Role = "consultor";
    const user = await createUser(req.tenantId, {
      email: b.email,
      password: b.password,
      name: b.name,
      role: safeRole,
    });
    const { sessionToken, refreshToken } = await createSessionWithRefresh(req.tenantId, user.id, meta(req));
    setSessionCookie(reply, sessionToken);
    setRefreshCookie(reply, refreshToken);
    await recordAuthEvent(req.tenantId, "SIGNUP", user.id, meta(req));
    return reply.send({ success: true, user });
  } catch (err) {
    logger.error({ err }, "Fallo en /api/auth/signup");
    // FIX M18: no leakear err.message del backend (puede incluir SQL/schema).
    return reply.code(400).send({
      success: false,
      error: "No se pudo crear el usuario. Verificá los datos e intentá de nuevo.",
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
    const user = await findUserByEmail(req.tenantId, b.email);
    if (!user || !user.active) {
      await recordAuthEvent(req.tenantId, "LOGIN_FAIL", user?.id || null, { ...meta(req), details: { reason: !user ? "no_user" : "inactive", email: b.email } });
      return reply.code(401).send({ success: false, error: "Credenciales inválidas" });
    }
    const ok = await verifyPassword(b.password, user.password_hash);
    if (!ok) {
      await recordAuthEvent(req.tenantId, "LOGIN_FAIL", user.id, { ...meta(req), details: { reason: "bad_password" } });
      return reply.code(401).send({ success: false, error: "Credenciales inválidas" });
    }
    const { sessionToken, refreshToken } = await createSessionWithRefresh(req.tenantId, user.id, meta(req));
    setSessionCookie(reply, sessionToken);
    setRefreshCookie(reply, refreshToken);
    await recordAuthEvent(req.tenantId, "LOGIN_SUCCESS", user.id, meta(req));
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
  let userId: string | null = null;
  if (token) {
    const u = await getUserBySession(req.tenantId, token).catch(() => null);
    userId = u?.id || null;
    await deleteSession(req.tenantId, token);
  }
  clearSessionCookie(reply);
  if (userId) await recordAuthEvent(req.tenantId, "LOGOUT", userId, meta(req));
  return reply.send({ success: true });
}

// POST /api/auth/refresh — rota el refresh token, emite session+refresh nuevos.
// Onda 7.2: "sin token" responde 200 {success:false} en vez de 401 — es el
// probe normal de sesión desde /login y el 401 ensuciaba la consola del
// browser (el dev-overlay de Next lo contaba como error). Un cliente sin
// cookie NO es un error: es simplemente "no autenticado".
export async function postRefresh(req: FastifyRequest, reply: FastifyReply) {
  const refresh = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE_NAME];
  if (!refresh) return reply.send({ success: false, error: "no_refresh_token" });
  const result = await rotateRefreshToken(req.tenantId, refresh, meta(req));
  if (!result) {
    clearSessionCookie(reply);
    return reply.send({ success: false, error: "refresh_invalid" });
  }
  setSessionCookie(reply, result.sessionToken);
  setRefreshCookie(reply, result.refreshToken);
  return reply.send({ success: true, expiresAt: result.refreshExpiresAt });
}

// GET /api/auth/sessions — lista los dispositivos del usuario actual.
export async function getSessions(req: FastifyRequest, reply: FastifyReply) {
  const token = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!token) return reply.code(401).send({ success: false, error: "no_session" });
  const user = await getUserBySession(req.tenantId, token);
  if (!user) return reply.code(401).send({ success: false, error: "no_session" });
  const sessions = await listUserSessions(req.tenantId, user.id);
  // Marcar cuál es la sesión actual
  const annotated = sessions.map((s) => ({ ...s, current: s.id === token }));
  return reply.send({ success: true, sessions: annotated });
}

// POST /api/auth/logout-all — revoca todas las sesiones del usuario actual.
export async function postLogoutAll(req: FastifyRequest, reply: FastifyReply) {
  const token = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!token) return reply.code(401).send({ success: false, error: "no_session" });
  const user = await getUserBySession(req.tenantId, token);
  if (!user) return reply.code(401).send({ success: false, error: "no_session" });
  await revokeAllSessions(req.tenantId, user.id, "user_initiated");
  clearSessionCookie(reply);
  return reply.send({ success: true });
}

// Onda 7.2: /me es el PROBE de sesión (AuthContext lo llama en cada carga,
// incluso en /login sin cookie). "No autenticado" se responde 200
// {success:false} para no generar 401s ruidosos en la consola del browser.
// Los endpoints protegidos de verdad siguen devolviendo 401 vía requireAuth.
export async function getMe(req: FastifyRequest, reply: FastifyReply) {
  const token = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!token) {
    return reply.send({ success: false, error: "no_session" });
  }
  const user = await getUserBySession(req.tenantId, token);
  if (!user) {
    clearSessionCookie(reply);
    return reply.send({ success: false, error: "invalid_session" });
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
  const user = await getUserBySession(req.tenantId, token);
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
  const users = await listUsers(req.tenantId);
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
    const updated = await updateUserRole(req.tenantId, req.params.id, newRole);
    if (!updated) return reply.code(404).send({ success: false, error: "usuario no encontrado" });
    return reply.send({ success: true, user: updated });
  } catch (err) {
    return reply.code(400).send({
      success: false,
      error: err instanceof Error ? err.message : "Error",
    });
  }
}

// =============================================================================
// v1.2.5-prod: Olvidé mi contraseña
// =============================================================================

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 * Siempre devuelve 200 OK (independiente de si el email existe) para no
 * permitir enumeration. Si existe, envía email con link de reset.
 */
export async function postForgotPassword(req: FastifyRequest, reply: FastifyReply) {
  const b = (req.body || {}) as { email?: string };
  if (!b.email || typeof b.email !== "string") {
    return reply.code(400).send({ success: false, error: "email es obligatorio" });
  }
  try {
    const issued = await createPasswordResetToken(b.email, meta(req));
    if (issued) {
      // Construir link público al frontend
      const baseUrl = (process.env.PUBLIC_BASE_URL || "https://ams.roccoai.cl").replace(/\/+$/, "");
      const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(issued.token)}`;
      sendPasswordReset({
        to: issued.email,
        name: issued.email.split("@")[0] ?? "Usuario",
        resetUrl,
        expiresInMinutes: 120,
      }).catch((e: unknown) => {
        logger.warn({ err: e, email: issued.email }, "sendPasswordReset failed (non-blocking)");
      });
    }
    // Respuesta genérica e idempotente
    return reply.send({
      success: true,
      message: "Si el email existe en el sistema, vas a recibir un link de reset en los próximos minutos.",
    });
  } catch (err) {
    logger.error({ err }, "Fallo en /api/auth/forgot-password");
    return reply.code(500).send({
      success: false,
      error: "Error procesando la solicitud. Intentá de nuevo o contactá al administrador.",
    });
  }
}

/**
 * GET /api/auth/reset-password?token=XXX
 * Validar un token sin hacer el cambio. Útil para que la UI muestre el form
 * solo si el token es válido (en vez de "Inválido" recién al submit).
 */
export async function getValidateResetToken(req: FastifyRequest, reply: FastifyReply) {
  const q = (req.query || {}) as { token?: string };
  if (!q.token) {
    return reply.code(400).send({ success: false, error: "token requerido" });
  }
  const v = await validatePasswordResetToken(q.token);
  if (!v.valid) {
    return reply.code(400).send({
      success: false,
      error: v.reason === "expired" ? "Este link expiró (válido por 2 horas)."
           : v.reason === "already_used" ? "Este link ya fue usado. Pedí uno nuevo."
           : "Link inválido. Pedí uno nuevo en 'Olvidé mi contraseña'.",
    });
  }
  return reply.send({ success: true, email: v.email });
}

/**
 * POST /api/auth/reset-password
 * Body: { token, newPassword }
 * Cambia la pass usando el token. Revoca sesiones existentes.
 */
export async function postResetPassword(req: FastifyRequest, reply: FastifyReply) {
  const b = (req.body || {}) as { token?: string; newPassword?: string };
  if (!b.token || !b.newPassword) {
    return reply.code(400).send({ success: false, error: "token y newPassword son obligatorios" });
  }
  if (b.newPassword.length < 8) {
    return reply.code(400).send({ success: false, error: "La contraseña debe tener al menos 8 caracteres" });
  }
  try {
    const r = await resetPasswordWithToken(b.token, b.newPassword, meta(req));
    if (!r.ok) {
      const msg = r.reason === "expired" ? "Este link expiró. Pedí uno nuevo."
                : r.reason === "already_used" ? "Este link ya fue usado."
                : r.reason === "not_found" ? "Link inválido. Pedí uno nuevo."
                : r.reason;
      return reply.code(400).send({ success: false, error: msg });
    }
    return reply.send({
      success: true,
      message: "Contraseña actualizada. Ya podés ingresar con tu nueva contraseña.",
    });
  } catch (err) {
    logger.error({ err }, "Fallo en /api/auth/reset-password");
    return reply.code(500).send({
      success: false,
      error: "Error procesando el cambio de contraseña. Intentá de nuevo.",
    });
  }
}
