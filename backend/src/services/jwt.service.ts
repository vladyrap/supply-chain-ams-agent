// =============================================================================
// jwt.service.ts — JWT minting + verify (v1.1.1-hotfix)
// =============================================================================
// FIX C6 (audit v1.1.0): fail-fast en producción si JWT_SECRET no está seteada
// o es < 32 chars. Antes arrancábamos silenciosamente con default público.
//
// Centraliza creación + verificación de tokens JWT para auth.
// Usa secret de JWT_SECRET (debe ser >= 32 chars).
// =============================================================================

import jwt from "jsonwebtoken";
import { logger } from "../utils/logger";

const DEV_FALLBACK = "dev-jwt-secret-DO-NOT-USE-IN-PROD-padding-to-meet-min-32-chars";
const IS_PROD = process.env.NODE_ENV === "production";
const RAW_SECRET = process.env.JWT_SECRET;

if (IS_PROD) {
  if (!RAW_SECRET || RAW_SECRET.length < 32) {
    // Fail-fast: si secret no existe o es corta en prod, abortar boot.
    // Mejor que aceptar tokens forjables.
    // eslint-disable-next-line no-console
    console.error(
      "FATAL: JWT_SECRET no seteada o < 32 chars en NODE_ENV=production. " +
        "Generar con: openssl rand -hex 32",
    );
    throw new Error("JWT_SECRET required in production (>= 32 chars).");
  }
}

const SECRET = RAW_SECRET ?? DEV_FALLBACK;
const TOKEN_TTL_HOURS = Number(process.env.JWT_TTL_HOURS ?? 8);

if (!IS_PROD && (!RAW_SECRET || RAW_SECRET.length < 32)) {
  logger.warn(
    "jwt.service: JWT_SECRET no seteada o < 32 chars — usando fallback dev. " +
      "NO usar en producción.",
  );
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  tenantId?: string;
  iat?: number;
  exp?: number;
}

export function signToken(payload: Omit<JwtPayload, "iat" | "exp">): string {
  return jwt.sign(payload, SECRET, {
    expiresIn: `${TOKEN_TTL_HOURS}h`,
    algorithm: "HS256", // explícito para evitar algorithm confusion
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    // Explicitamos algorithms para evitar `alg: none` attack si alguien acepta JWT.
    return jwt.verify(token, SECRET, { algorithms: ["HS256"] }) as JwtPayload;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, "jwt.verify failed");
    return null;
  }
}

export function decodeUnsafe(token: string): JwtPayload | null {
  try {
    return jwt.decode(token) as JwtPayload | null;
  } catch {
    return null;
  }
}
