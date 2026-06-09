// =============================================================================
// auth-google.routes.ts — SSO Google OAuth 2.0 (v1.1.0)
// =============================================================================
// Endpoint que redirige a Google, recibe callback con código, intercambia por
// access token, obtiene user info, upsertea en DB y entrega JWT propio.
//
// Activar:
//   1. GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET en .env
//   2. PUBLIC_BASE_URL en .env (ej: https://app.tuempresa.cl)
//   3. (Opcional) GOOGLE_OAUTH_ALLOWED_DOMAINS=tuempresa.cl,cliente.com
//
// Si las credenciales NO están seteadas, el plugin NO se registra
// (log warning silencioso). Backward compatible.
// =============================================================================

import type { FastifyInstance } from "fastify";
import oauthPlugin from "@fastify/oauth2";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { signToken } from "../services/jwt.service";
import { sendWelcome } from "../services/email.service";

interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  hd?: string; // hosted domain (Workspace)
}

export async function googleAuthRoutes(app: FastifyInstance): Promise<void> {
  const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:6700";

  if (!CLIENT_ID || !CLIENT_SECRET) {
    logger.warn("auth-google: GOOGLE_OAUTH_CLIENT_ID/SECRET no configurados — SSO Google deshabilitado");
    return;
  }

  const ALLOWED_DOMAINS = (process.env.GOOGLE_OAUTH_ALLOWED_DOMAINS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);

  await app.register(oauthPlugin, {
    name: "googleOAuth2",
    scope: ["openid", "email", "profile"],
    credentials: {
      client: { id: CLIENT_ID, secret: CLIENT_SECRET },
      auth: oauthPlugin.GOOGLE_CONFIGURATION,
    },
    startRedirectPath: "/api/auth/google",
    callbackUri: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/api/auth/callback/google`,
  });

  app.get("/api/auth/callback/google", async (req, reply) => {
    try {
      // @ts-expect-error - plugin agrega metodo dynamic
      const { token } = await app.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req);

      // Get user info from Google
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!userInfoRes.ok) {
        throw new Error(`Google userinfo HTTP ${userInfoRes.status}`);
      }
      const userInfo = (await userInfoRes.json()) as GoogleUserInfo;

      if (!userInfo.verified_email) {
        logger.warn({ email: userInfo.email }, "auth-google: email not verified");
        return reply.redirect(`${PUBLIC_BASE_URL}/login?error=email_not_verified`);
      }

      // Domain check (si configurado)
      if (ALLOWED_DOMAINS.length > 0) {
        const matches = ALLOWED_DOMAINS.some((d) => userInfo.email.endsWith(`@${d}`));
        if (!matches) {
          logger.warn({ email: userInfo.email, hd: userInfo.hd }, "auth-google: domain not allowed");
          return reply.redirect(`${PUBLIC_BASE_URL}/login?error=domain_not_allowed`);
        }
      }

      // Upsert user en DB
      const { rows } = await query<{ id: string; role: string; tenant_id: string | null; is_new: boolean }>(
        `INSERT INTO users (email, name, role, is_active, password_hash, auth_provider)
         VALUES ($1, $2, 'viewer', true, '', 'google')
         ON CONFLICT (email) DO UPDATE SET
            name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
            auth_provider = COALESCE(users.auth_provider, EXCLUDED.auth_provider),
            last_login_at = NOW()
         RETURNING id, role, tenant_id, (xmax = 0) AS is_new`,
        [userInfo.email, userInfo.name],
      );

      const dbUser = rows[0];
      if (!dbUser) {
        throw new Error("Failed to upsert user");
      }

      // Audit event
      await query(
        `INSERT INTO audit_events (event_type, category, severity, source, actor_user_id, actor_name, payload)
         VALUES ('USER_LOGIN_SSO', 'security', 'info', 'auth', $1, $2, $3::jsonb)`,
        [dbUser.id, userInfo.email, JSON.stringify({ provider: "google", isNew: dbUser.is_new })],
      ).catch(() => { /* best-effort */ });

      // Send welcome email if new
      if (dbUser.is_new) {
        sendWelcome({
          to: userInfo.email,
          name: userInfo.name,
          loginUrl: `${PUBLIC_BASE_URL}/dashboard`,
        }).catch((err) => logger.warn({ err }, "welcome email failed"));
      }

      // Crear JWT propio
      const sessionToken = signToken({
        userId: dbUser.id,
        email: userInfo.email,
        role: dbUser.role,
        tenantId: dbUser.tenant_id || undefined,
      });

      // Set cookie + redirect a app
      reply.setCookie("ams_session", sessionToken, {
        path: "/",
        httpOnly: true,
        secure: PUBLIC_BASE_URL.startsWith("https://"),
        sameSite: "lax",
        maxAge: 8 * 60 * 60, // 8h
      });

      return reply.redirect(`${PUBLIC_BASE_URL}/dashboard`);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "google oauth callback failed");
      return reply.redirect(`${PUBLIC_BASE_URL}/login?error=oauth_failed`);
    }
  });

  logger.info({ allowedDomains: ALLOWED_DOMAINS }, "auth-google: SSO Google habilitado");
}
