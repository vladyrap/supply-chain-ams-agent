import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import type { Role, User, UserWithPasswordHash } from "../types/auth.types";

const VALID_ROLES = new Set<Role>(["viewer", "consultor", "aprobador", "admin"]);
const SESSION_TTL_DAYS = 30;
const BCRYPT_ROUNDS = 10;

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
  role?: Role;
}

export async function createUser(input: SignupInput): Promise<User> {
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
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, name, role, active, created_at`,
    [email, hash, input.name ?? null, role]
  );
  return rows[0]!;
}

export async function findUserByEmail(email: string): Promise<UserWithPasswordHash | null> {
  const { rows } = await query<UserWithPasswordHash>(
    `SELECT id, email, name, role, active, created_at, password_hash
       FROM users
      WHERE LOWER(email) = LOWER($1)`,
    [email]
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await query<User>(
    `SELECT id, email, name, role, active, created_at
       FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSession(userId: string, userAgent?: string): Promise<string> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [token, userId, expiresAt.toISOString(), userAgent ?? null]
  );
  return token;
}

export async function getUserBySession(sessionId: string): Promise<User | null> {
  const { rows } = await query<User>(
    `SELECT u.id, u.email, u.name, u.role, u.active, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.active = true`,
    [sessionId]
  );
  return rows[0] ?? null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

export async function listUsers(): Promise<User[]> {
  const { rows } = await query<User>(
    `SELECT id, email, name, role, active, created_at
       FROM users ORDER BY created_at DESC LIMIT 200`
  );
  return rows;
}

export async function updateUserRole(userId: string, role: Role): Promise<User | null> {
  if (!VALID_ROLES.has(role)) throw new Error("Rol inválido");
  const { rows } = await query<User>(
    `UPDATE users SET role = $1, updated_at = now()
      WHERE id = $2
      RETURNING id, email, name, role, active, created_at`,
    [role, userId]
  );
  return rows[0] ?? null;
}

// Bootstrap: si no hay usuarios, crear admin por defecto desde env vars.
export async function bootstrapAdminIfNeeded(): Promise<void> {
  const adminEmail = process.env.AMS_BOOTSTRAP_ADMIN_EMAIL;
  const adminPass = process.env.AMS_BOOTSTRAP_ADMIN_PASSWORD;
  if (!adminEmail || !adminPass) return;
  try {
    const { rows } = await query<{ c: string }>("SELECT count(*)::text AS c FROM users");
    if (Number(rows[0]?.c ?? 0) > 0) return;
    await createUser({
      email: adminEmail,
      password: adminPass,
      name: "Administrador",
      role: "admin",
    });
    logger.info({ email: adminEmail }, "Bootstrap admin creado");
  } catch (err) {
    logger.warn({ err }, "bootstrap admin falló (no es crítico)");
  }
}
