// =============================================================================
// jwt.service.ts — JWT minting + verify (v1.1.0)
// =============================================================================
// Centraliza creación + verificación de tokens JWT para auth.
// Usa secret de JWT_SECRET (debe ser >= 32 chars hex).
// =============================================================================

import jwt from "jsonwebtoken";
import { logger } from "../utils/logger";

const SECRET = process.env.JWT_SECRET || "dev-jwt-secret-CHANGE-IN-PROD-please-32-chars-min";
const TOKEN_TTL_HOURS = Number(process.env.JWT_TTL_HOURS ?? 8);

if (SECRET.length < 32) {
  logger.warn("jwt.service: JWT_SECRET muy corta (<32 chars). Usar 'openssl rand -hex 32' para prod.");
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
  return jwt.sign(payload, SECRET, { expiresIn: `${TOKEN_TTL_HOURS}h` });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, SECRET) as JwtPayload;
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
