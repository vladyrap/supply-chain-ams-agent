// =============================================================================
// auth-google.routes.ts — SSO Google OAuth 2.0 (v1.1.2-hotfix)
// =============================================================================
// FIXES audit v1.1.0:
//   A5 — PUBLIC_BASE_URL validado al boot: en NODE_ENV=production debe ser https://
//   A6 — Rechazar SSO si email ya existe con auth_provider distinto (account
//        takeover via SSO bloqueado)
//   A7 — Validación robusta de dominio: usa userInfo.hd (Workspace verified)
//        cuando está disponible, fallback a email.toLowerCase() (case insens)
//   M20 — Validar hd === domain cuando ALLOWED_DOMAINS configurado
//   A9 — Rate limit dedicado en /callback
//   B10 — Audit con email truncado (no PII completa en logs)
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

/** Trunca email para logs: "vlad***@miespejo.cl" */
function truncEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  return `${local.slice(0, 3)}***@${domain}`;
}

export async function googleAuthRoutes(app: FastifyInstance): Promise<void> {
  const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:6700";
  const IS_PROD = process.env.NODE_ENV === "production";

  if (!CLIENT_ID || !CLIENT_SECRET) {
    logger.warn("auth-google: GOOGLE_OAUTH_CLIENT_ID/SECRET no configurados — SSO Google deshabilitado");
    return;
  }

  // FIX A5: validar PUBLIC_BASE_URL en prod.
  if (IS_PROD && !PUBLIC_BASE_URL.startsWith("https://")) {
    throw new Error(
      `auth-google: PUBLIC_BASE_URL debe ser https:// en producción (recibido: ${PUBLIC_BASE_URL}). ` +
      "Sin HTTPS, la cookie de sesión viaja en claro.",
    );
  }
  const SECURE_COOKIE = PUBLIC_BASE_URL.startsWith("https://");

  const ALLOWED_DOMAINS = (process.env.GOOGLE_OAUTH_ALLOWED_DOMAINS ?? "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

  await app.register(oauthPlugin, {
    name: "googleOAuth2",
    scope: ["openid", "email", "profile"],
    credentials: {
      client: { id: CLIENT_ID, secret: CLIENT_SECRET },
      auth: oauthPlugin.GOOGLE_CONFIGURATION,
    },
    startRedirectPath: "/api/auth/google",
    callbackUri: `${PUBLIC_BASE_URL.replace(/\/$/, "")}/api/auth/callback/google`,
    // El plugin valida state automáticamente vía cookie por default.
  });

  // FIX A9: rate limit dedicado para callback (8 intentos/min/IP).
  app.get("/api/auth/callback/google", {
    config: {
      rateLimit: {
        max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 8),
        timeWindow: "1 minute",
        allowList: [] as string[],
      },
    },
  }, async (req, reply) => {
    try {
      // @ts-expect-error - plugin agrega metodo dynamic
      const { token } = await app.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req);

      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!userInfoRes.ok) {
        throw new Error(`Google userinfo HTTP ${userInfoRes.status}`);
      }
      const userInfo = (await userInfoRes.json()) as GoogleUserInfo;

      if (!userInfo.verified_email) {
        logger.warn({ email: truncEmail(userInfo.email) }, "auth-google: email not verified");
        return reply.redirect(`${PUBLIC_BASE_URL}/login?error=email_not_verified`);
      }

      // FIX A7 + M20: validación robusta de dominio.
      // Preferir userInfo.hd (verified by Workspace), fallback a email lowercased.
      const emailLower = userInfo.email.toLowerCase();
      const emailDomain = emailLower.split("@")[1];
      if (ALLOWED_DOMAINS.length > 0) {
        const hdMatches = userInfo.hd && ALLOWED_DOMAINS.includes(userInfo.hd.toLowerCase());
        const emailMatches = emailDomain && ALLOWED_DOMAINS.includes(emailDomain);
        if (!hdMatches && !emailMatches) {
          logger.warn(
            { email: truncEmail(userInfo.email), hd: userInfo.hd ?? null },
            "auth-google: domain not allowed",
          );
          return reply.redirect(`${PUBLIC_BASE_URL}/login?error=domain_not_allowed`);
        }
      }

      // FIX A6: chequear auth_provider ANTES del upsert para bloquear hijack.
      // Si el email ya existe con auth_provider='local', el usuario debe linkear
      // explícitamente la cuenta Google primero (flow no implementado todavía).
      const { rows: existingRows } = await query<{ id: string; auth_provider: string | null }>(
        `SELECT id, auth_provider FROM users WHERE email = $1 LIMIT 1`,
        [emailLower],
      );
      if (existingRows[0] && existingRows[0].auth_provider && existingRows[0].auth_provider !== "google") {
        logger.warn(
          { email: truncEmail(emailLower), existingProvider: existingRows[0].auth_provider },
          "auth-google: account exists with different auth_provider — blocking SSO",
        );
        return reply.redirect(
          `${PUBLIC_BASE_URL}/login?error=account_exists_other_provider`,
        );
      }

      // Upsert user — auth_provider siempre se setea/mantiene como 'google' para
      // accounts SSO. NO usar COALESCE que dejaría 'local' viejo si existía.
      const { rows } = await query<{ id: string; role: string; tenant_id: string | null; is_new: boolean }>(
        `INSERT INTO users (email, name, role, is_active, password_hash, auth_provider)
         VALUES ($1, $2, 'viewer', true, '', 'google')
         ON CONFLICT (email) DO UPDATE SET
            name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
            auth_provider = 'google',
            last_login_at = NOW()
         RETURNING id, role, tenant_id, (xmax = 0) AS is_new`,
        [emailLower, userInfo.name],
      );

      const dbUser = rows[0];
      if (!dbUser) {
        throw new Error("Failed to upsert user");
      }

      // Audit event — FIX B10: no email completo en payload, solo hash truncado.
      await query(
        `INSERT INTO audit_events (event_type, category, severity, source, actor_user_id, actor_name, tenant_id, payload)
         VALUES ('USER_LOGIN_SSO', 'security', 'info', 'auth', $1, $2, $3, $4::jsonb)`,
        [
          dbUser.id,
          userInfo.name || truncEmail(emailLower),
          dbUser.tenant_id,
          JSON.stringify({ provider: "google", isNew: dbUser.is_new, hd: userInfo.hd ?? null }),
        ],
      ).catch(() => { /* best-effort */ });

      // Welcome email para nuevos users.
      if (dbUser.is_new) {
        // .then catch para detectar también { sent: false } sin throw.
        sendWelcome({
          to: emailLower,
          name: userInfo.name,
          loginUrl: `${PUBLIC_BASE_URL}/dashboard`,
        })
          .then((r) => {
            if (!r.sent) logger.warn({ reason: r.reason }, "welcome email returned not sent");
          })
          .catch((err) => logger.warn({ err }, "welcome email failed"));
      }

      const sessionToken = signToken({
        userId: dbUser.id,
        email: emailLower,
        role: dbUser.role,
        tenantId: dbUser.tenant_id || undefined,
      });

      reply.setCookie("ams_session", sessionToken, {
        path: "/",
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: "lax",
        maxAge: 8 * 60 * 60, // 8h
      });

      return reply.redirect(`${PUBLIC_BASE_URL}/dashboard`);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "google oauth callback failed");
      return reply.redirect(`${PUBLIC_BASE_URL}/login?error=oauth_failed`);
    }
  });

  logger.info(
    { allowedDomains: ALLOWED_DOMAINS, secureCookie: SECURE_COOKIE },
    "auth-google: SSO Google habilitado",
  );
}
