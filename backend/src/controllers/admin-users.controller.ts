// =============================================================================
// admin-users.controller.ts — Invitar usuarios reales (auth + RBAC + email)
// =============================================================================
// v1.2.8-prod · POST /api/admin/users/invite
//
// Flujo:
//   1. Validar input (name, email, roleCode, serviceLevel)
//   2. Crear cuenta en tabla `users` con password random (que nunca se usa)
//   3. Crear/upsert row en `platform_users` (RBAC)
//   4. Generar password_reset_token con TTL 7 días (bienvenida)
//   5. Enviar email con link de set-password
//   6. Devolver el row creado (sin secrets)
//
// Si email ya existe: 409 conflict.
// =============================================================================

import type { FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import {
  createUser,
  findUserByEmail,
  createPasswordResetToken,
} from "../services/auth.service";
import { sendPasswordReset } from "../services/email.service";
import * as rbac from "../services/rbac.service";
import { logger } from "../utils/logger";

interface InviteBody {
  name: string;
  email: string;
  roleCode: string;
  serviceLevel?: string;
}

function meta(req: FastifyRequest): { ip?: string; userAgent?: string } {
  return {
    ip: req.ip,
    userAgent: req.headers["user-agent"] as string | undefined,
  };
}

export async function postInviteUser(req: FastifyRequest, reply: FastifyReply) {
  const tenantId = (req as FastifyRequest & { tenantId?: string }).tenantId || "default";
  const b = (req.body || {}) as Partial<InviteBody>;

  if (!b.name || !b.email || !b.roleCode) {
    return reply.code(400).send({
      success: false,
      error: "name, email y roleCode son obligatorios",
    });
  }
  const email = b.email.trim().toLowerCase();
  if (!email.includes("@")) {
    return reply.code(400).send({ success: false, error: "Email inválido" });
  }

  try {
    // 1. Verificar que email no exista ya
    const existing = await findUserByEmail(tenantId, email);
    if (existing) {
      return reply.code(409).send({
        success: false,
        error: "Ya existe un usuario con ese email en este tenant",
      });
    }

    // 2. Crear cuenta auth con password random (nunca se usa, se cambia via reset)
    const randomPwd = crypto.randomBytes(24).toString("base64url"); // 32 chars
    const authUser = await createUser(tenantId, {
      email,
      password: randomPwd,
      name: b.name.trim(),
      role: "consultor", // rol auth por default (el real RBAC va en platform_users)
    });

    // 3. Upsert en platform_users (RBAC)
    const platformUser = await rbac.upsertUser(tenantId, {
      id: authUser.id,
      name: b.name.trim(),
      email,
      roleCode: b.roleCode,
      serviceLevel: (b.serviceLevel as "BASIC" | "STANDARD" | "PREMIUM" | "ENTERPRISE" | undefined) ?? "STANDARD",
      status: "ACTIVE",
      createdAt: authUser.created_at,
    });

    // 4. Generar reset token + 5. enviar email (TTL fijo del servicio)
    const issued = await createPasswordResetToken(email, meta(req));
    let emailSent = false;
    if (issued) {
      const baseUrl = (process.env.PUBLIC_BASE_URL || "https://ams.roccoai.cl").replace(
        /\/+$/,
        "",
      );
      const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(issued.token)}`;
      const r = await sendPasswordReset({
        to: email,
        name: b.name.trim(),
        resetUrl,
        expiresInMinutes: 120, // 2h default del servicio
      });
      emailSent = r.sent;
      if (!r.sent) {
        logger.warn({ to: email, reason: r.reason }, "invite email failed (user created OK)");
      }
    }

    return reply.send({
      success: true,
      user: platformUser,
      emailSent,
      message: emailSent
        ? `Usuario creado y email enviado a ${email}`
        : `Usuario creado pero email NO se pudo enviar (revisar SMTP). El usuario puede usar 'Olvidé contraseña' para setear su clave.`,
    });
  } catch (err) {
    logger.error({ err, email }, "invite user failed");
    return reply.code(500).send({
      success: false,
      error: "Error invitando usuario: " + (err as Error).message,
    });
  }
}
