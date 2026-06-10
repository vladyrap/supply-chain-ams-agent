import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import type { Role, User, UserWithPasswordHash } from "../types/auth.types";

const VALID_ROLES = new Set<Role>(["viewer", "consultor", "aprobador", "admin"]);
const SESSION_TTL_DAYS = 30;
const REFRESH_TTL_DAYS = 60;
// 12 rounds = ~250ms en CPU típica. Más seguro que 10. Si subís a 14 sumás 1s por login.
const BCRYPT_ROUNDS = Number(process.env.AUTH_BCRYPT_ROUNDS || 12);

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

let hardenedSchemaEnsured = false;
async function ensureHardenedSchema(): Promise<void> {
  if (hardenedSchemaEnsured) return;
  try {
    // Sessions con metadata extra (idempotente).
    await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ`).catch(() => null);
    await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`).catch(() => null);
    await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip_address TEXT`).catch(() => null);

    // Tabla de refresh tokens separada (rotation-friendly).
    await query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id            TEXT PRIMARY KEY,
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        session_id    TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        expires_at    TIMESTAMPTZ NOT NULL,
        used_at       TIMESTAMPTZ,
        revoked_at    TIMESTAMPTZ,
        replaced_by   TEXT,
        user_agent    TEXT,
        ip_address    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_rt_user    ON refresh_tokens(user_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_rt_session ON refresh_tokens(session_id);`);

    // Audit log auth
    await query(`
      CREATE TABLE IF NOT EXISTS auth_events (
        id         BIGSERIAL PRIMARY KEY,
        user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
        event      TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        details    JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_auth_evt_user    ON auth_events(user_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_auth_evt_event   ON auth_events(event);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_auth_evt_created ON auth_events(created_at DESC);`);

    hardenedSchemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure auth hardened schema failed");
  }
}

export async function recordAuthEvent(
  tenantId: string,
  event: "LOGIN_SUCCESS" | "LOGIN_FAIL" | "LOGOUT" | "REFRESH" | "REVOKE_ALL" | "SIGNUP" | "PASSWORD_RESET_REQUESTED" | "PASSWORD_RESET_COMPLETED",
  userId: string | null,
  meta: { ip?: string; userAgent?: string; details?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    await ensureHardenedSchema();
    await query(
      `INSERT INTO auth_events (tenant_id, user_id, event, ip_address, user_agent, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [tenantId, userId, event, meta.ip || null, meta.userAgent || null,
       meta.details ? JSON.stringify(meta.details) : null]
    );
  } catch (err) {
    logger.debug({ err }, "auth event log failed");
  }
}

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
  role?: Role;
}

export async function createUser(tenantId: string, input: SignupInput): Promise<User> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("Email inválido");
  }
  if (!input.password || input.password.length < 8) {
    throw new Error("La contraseña debe tener al menos 8 caracteres");
  }
  const role: Role = input.role && VALID_ROLES.has(input.role) ? input.role : "consultor";
  const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  const { rows } = await query<User>(
    `INSERT INTO users (tenant_id, email, password_hash, name, role)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, name, role, active, created_at`,
    [tenantId, email, hash, input.name ?? null, role]
  );
  return rows[0]!;
}

export async function findUserByEmail(tenantId: string, email: string): Promise<UserWithPasswordHash | null> {
  const { rows } = await query<UserWithPasswordHash>(
    `SELECT id, email, name, role, active, created_at, password_hash
       FROM users
      WHERE LOWER(email) = LOWER($1)
        AND tenant_id = $2`,
    [email, tenantId]
  );
  return rows[0] ?? null;
}

export async function findUserById(tenantId: string, id: string): Promise<User | null> {
  const { rows } = await query<User>(
    `SELECT id, email, name, role, active, created_at
       FROM users WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(tenantId: string, userId: string, userAgent?: string, ip?: string): Promise<string> {
  await ensureHardenedSchema();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO sessions (id, tenant_id, user_id, expires_at, user_agent, ip_address, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [token, tenantId, userId, expiresAt.toISOString(), userAgent ?? null, ip ?? null]
  );
  return token;
}

export interface SessionWithRefresh {
  sessionToken: string;
  refreshToken: string;
  refreshExpiresAt: string;
}

/** Crea sesión + refresh token. Pensado para login. */
export async function createSessionWithRefresh(tenantId: string, userId: string, meta: { userAgent?: string; ip?: string } = {}): Promise<SessionWithRefresh> {
  await ensureHardenedSchema();
  const sessionToken = await createSession(tenantId, userId, meta.userAgent, meta.ip);
  const refreshToken = crypto.randomBytes(48).toString("hex");
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO refresh_tokens (id, tenant_id, user_id, session_id, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [refreshToken, tenantId, userId, sessionToken, refreshExpiresAt.toISOString(),
     meta.userAgent || null, meta.ip || null]
  );
  return { sessionToken, refreshToken, refreshExpiresAt: refreshExpiresAt.toISOString() };
}

/** Rotación: marca el viejo como usado, crea uno nuevo. Si ya fue usado → es ataque, revocamos todo. */
export async function rotateRefreshToken(tenantId: string, oldRefresh: string, meta: { userAgent?: string; ip?: string } = {}): Promise<SessionWithRefresh | null> {
  await ensureHardenedSchema();
  const { rows } = await query<{
    id: string; user_id: string; session_id: string | null;
    expires_at: string; used_at: string | null; revoked_at: string | null;
  }>(
    `SELECT id, user_id, session_id, expires_at, used_at, revoked_at
       FROM refresh_tokens WHERE id = $1 AND tenant_id = $2`,
    [oldRefresh, tenantId]
  );
  const t = rows[0];
  if (!t) return null;
  if (t.revoked_at || new Date(t.expires_at).getTime() < Date.now()) return null;
  if (t.used_at) {
    // Reuso detectado → revocamos toda la familia de refresh tokens del usuario por seguridad.
    logger.warn({ userId: t.user_id, oldRefresh: oldRefresh.slice(0, 8) }, "refresh token reuse detected, revoking all");
    await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND tenant_id = $2`, [t.user_id, tenantId]);
    await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND tenant_id = $2`, [t.user_id, tenantId]);
    await recordAuthEvent(tenantId, "REVOKE_ALL", t.user_id, { ip: meta.ip, userAgent: meta.userAgent, details: { reason: "refresh_reuse" } });
    return null;
  }
  const fresh = await createSessionWithRefresh(tenantId, t.user_id, meta);
  await query(
    `UPDATE refresh_tokens SET used_at = now(), replaced_by = $1 WHERE id = $2 AND tenant_id = $3`,
    [fresh.refreshToken, t.id, tenantId]
  );
  await recordAuthEvent(tenantId, "REFRESH", t.user_id, { ip: meta.ip, userAgent: meta.userAgent });
  return fresh;
}

/** Logout en TODOS los dispositivos del usuario. */
export async function revokeAllSessions(tenantId: string, userId: string, reason = "manual"): Promise<void> {
  await ensureHardenedSchema();
  await query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND tenant_id = $2`, [userId, tenantId]);
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND tenant_id = $2`, [userId, tenantId]);
  await recordAuthEvent(tenantId, "REVOKE_ALL", userId, { details: { reason } });
}

export interface SessionRow {
  id: string;
  userId: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  revokedAt: string | null;
}

/** Lista sesiones activas del usuario (para UI "tus dispositivos"). */
export async function listUserSessions(tenantId: string, userId: string): Promise<SessionRow[]> {
  await ensureHardenedSchema();
  const { rows } = await query<{
    id: string; user_id: string; user_agent: string | null; ip_address: string | null;
    created_at: string; last_used_at: string | null; expires_at: string; revoked_at: string | null;
  }>(
    `SELECT id, user_id, user_agent, ip_address, created_at, last_used_at, expires_at, revoked_at
       FROM sessions WHERE user_id = $1 AND tenant_id = $2 ORDER BY last_used_at DESC NULLS LAST, created_at DESC LIMIT 50`,
    [userId, tenantId]
  );
  return rows.map((r) => ({
    id: r.id, userId: r.user_id, userAgent: r.user_agent, ipAddress: r.ip_address,
    createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

export async function getUserBySession(tenantId: string, sessionId: string): Promise<User | null> {
  await ensureHardenedSchema();
  const { rows } = await query<User>(
    `SELECT u.id, u.email, u.name, u.role, u.active, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
        AND s.expires_at > now()
        AND s.revoked_at IS NULL
        AND u.active = true
        AND s.tenant_id = $2
        AND u.tenant_id = $2`,
    [sessionId, tenantId]
  );
  if (rows[0]) {
    // touch last_used_at en background (no esperamos)
    query(`UPDATE sessions SET last_used_at = now() WHERE id = $1 AND tenant_id = $2`, [sessionId, tenantId]).catch(() => null);
  }
  return rows[0] ?? null;
}

export async function deleteSession(tenantId: string, sessionId: string): Promise<void> {
  // Soft-delete: marcar como revocada (auditable). El TTL hace el cleanup eventual.
  await ensureHardenedSchema().catch(() => null);
  await query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND tenant_id = $2`, [sessionId, tenantId]).catch(async () => {
    // Fallback si la columna no existe aún
    await query(`DELETE FROM sessions WHERE id = $1 AND tenant_id = $2`, [sessionId, tenantId]);
  });
  // Revocar refresh tokens asociados
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL AND tenant_id = $2`, [sessionId, tenantId])
    .catch(() => null);
}

export async function listUsers(tenantId: string): Promise<User[]> {
  const { rows } = await query<User>(
    `SELECT id, email, name, role, active, created_at
       FROM users
      WHERE tenant_id = $1
      ORDER BY created_at DESC LIMIT 200`,
    [tenantId]
  );
  return rows;
}

export async function updateUserRole(tenantId: string, userId: string, role: Role): Promise<User | null> {
  if (!VALID_ROLES.has(role)) throw new Error("Rol inválido");
  const { rows } = await query<User>(
    `UPDATE users SET role = $1, updated_at = now()
      WHERE id = $2 AND tenant_id = $3
      RETURNING id, email, name, role, active, created_at`,
    [role, userId, tenantId]
  );
  return rows[0] ?? null;
}

// =============================================================================
// Password reset flow (v1.2.5-prod feature "olvidé contraseña")
// =============================================================================
// 1. createPasswordResetToken(email)   → genera token, lo guarda, retorna el token
//    (silencioso si email no existe — no revelar enumeration)
// 2. validatePasswordResetToken(token) → ¿es válido? ¿expirado? ¿usado? → user
// 3. resetPasswordWithToken(token, newPassword) → cambia pass + invalida token +
//    revoca todas las sesiones del user
// =============================================================================

const PASSWORD_RESET_TTL_HOURS = 2;

export interface PasswordResetTokenIssue {
  token: string;     // opaco, mandar por email en el link
  userId: string;
  email: string;
  expiresAt: string; // ISO
}

/**
 * Crea un token de reset si el email existe en algún tenant.
 * Retorna el token (para que el caller envíe el email) o null si no encontró
 * usuario — el caller NO debe revelar al cliente si el email existió o no.
 */
export async function createPasswordResetToken(
  email: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<PasswordResetTokenIssue | null> {
  await ensureHardenedSchema();
  // Crear tabla si no existe (defensivo, también está en migration 009)
  await query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id           TEXT PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email        TEXT NOT NULL,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      ip_address   TEXT,
      user_agent   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => null);

  // Buscar user en CUALQUIER tenant (sin filtro tenant_id porque el user
  // simplemente tipea su email; el tenant se infiere del row encontrado).
  const { rows } = await query<{ id: string; tenant_id: string; email: string }>(
    `SELECT id, tenant_id, email FROM users
      WHERE LOWER(email) = LOWER($1) AND active = true
      LIMIT 1`,
    [email]
  );
  const user = rows[0];
  if (!user) {
    // Silencio intencional — no revelar enumeration.
    return null;
  }

  const token = crypto.randomBytes(32).toString("hex"); // 64 chars
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_HOURS * 60 * 60 * 1000);
  await query(
    `INSERT INTO password_reset_tokens (id, user_id, tenant_id, email, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [token, user.id, user.tenant_id, user.email, expiresAt.toISOString(), meta.ip ?? null, meta.userAgent ?? null]
  );
  await recordAuthEvent(user.tenant_id, "PASSWORD_RESET_REQUESTED", user.id, {
    ip: meta.ip, userAgent: meta.userAgent, details: { email: user.email },
  });
  return {
    token,
    userId: user.id,
    email: user.email,
    expiresAt: expiresAt.toISOString(),
  };
}

export interface ResetTokenValidation {
  valid: boolean;
  reason?: "not_found" | "expired" | "already_used";
  userId?: string;
  tenantId?: string;
  email?: string;
}

/** Valida que el token exista, no esté usado y no expirado. */
export async function validatePasswordResetToken(token: string): Promise<ResetTokenValidation> {
  if (!token || typeof token !== "string" || token.length < 16) {
    return { valid: false, reason: "not_found" };
  }
  const { rows } = await query<{
    user_id: string; tenant_id: string; email: string; expires_at: string; used_at: string | null;
  }>(
    `SELECT user_id, tenant_id, email, expires_at, used_at
       FROM password_reset_tokens WHERE id = $1`,
    [token]
  );
  const r = rows[0];
  if (!r) return { valid: false, reason: "not_found" };
  if (r.used_at) return { valid: false, reason: "already_used" };
  if (new Date(r.expires_at).getTime() < Date.now()) {
    return { valid: false, reason: "expired" };
  }
  return {
    valid: true,
    userId: r.user_id,
    tenantId: r.tenant_id,
    email: r.email,
  };
}

/**
 * Cambia la contraseña usando un token válido. Marca el token como usado +
 * revoca todas las sesiones activas del usuario por seguridad.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ ok: true; userId: string; email: string } | { ok: false; reason: string }> {
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, reason: "Password debe tener al menos 8 caracteres" };
  }
  const validation = await validatePasswordResetToken(token);
  if (!validation.valid) {
    return { ok: false, reason: validation.reason ?? "Token inválido" };
  }
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  // Transacción: update password + mark token used + revoke sessions
  await query("BEGIN");
  try {
    await query(
      `UPDATE users SET password_hash = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3`,
      [hash, validation.userId, validation.tenantId]
    );
    await query(
      `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`,
      [token]
    );
    await query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND tenant_id = $2`,
      [validation.userId, validation.tenantId]
    );
    await query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND tenant_id = $2`,
      [validation.userId, validation.tenantId]
    );
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK").catch(() => null);
    throw err;
  }
  await recordAuthEvent(validation.tenantId!, "PASSWORD_RESET_COMPLETED", validation.userId!, {
    ip: meta.ip, userAgent: meta.userAgent, details: { email: validation.email },
  });
  return { ok: true, userId: validation.userId!, email: validation.email! };
}

// Bootstrap: si no hay usuarios, crear admin por defecto desde env vars.
// Acepta tenantId opcional; si no se pasa, usa 'default' (bootstrap inicial single-tenant).
export async function bootstrapAdminIfNeeded(tenantId: string = "default"): Promise<void> {
  const adminEmail = process.env.AMS_BOOTSTRAP_ADMIN_EMAIL;
  const adminPass = process.env.AMS_BOOTSTRAP_ADMIN_PASSWORD;
  if (!adminEmail || !adminPass) return;
  try {
    const { rows } = await query<{ c: string }>(
      "SELECT count(*)::text AS c FROM users WHERE tenant_id = $1",
      [tenantId]
    );
    if (Number(rows[0]?.c ?? 0) > 0) return;
    await createUser(tenantId, {
      email: adminEmail,
      password: adminPass,
      name: "Administrador",
      role: "admin",
    });
    logger.info({ email: adminEmail, tenantId }, "Bootstrap admin creado");
  } catch (err) {
    logger.warn({ err }, "bootstrap admin falló (no es crítico)");
  }
}
