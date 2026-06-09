import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

// FIX M19 (audit v1.1.0): redaction extendida pino.
// Antes solo cookies/api-keys. Ahora cubre: auth headers, password bodies,
// secret env vars, tokens en payload, SQL error details, stack traces en err.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      // Headers sensibles
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['set-cookie']",
      "req.headers['x-csrf-bypass']",
      "req.headers['x-csrf-token']",
      "req.headers['x-api-key']",
      "req.headers['proxy-authorization']",
      // Request body con credenciales
      "req.body.password",
      "req.body.currentPassword",
      "req.body.newPassword",
      "req.body.tempPassword",
      "req.body.token",
      "req.body.refreshToken",
      "req.body.accessToken",
      "req.body.apiKey",
      "req.body.secret",
      // Response cookies
      'res.headers["set-cookie"]',
      // Internal config / env
      "ANTHROPIC_API_KEY",
      "anthropic_api_key",
      "GEMINI_API_KEY",
      "gemini_api_key",
      "GOOGLE_API_KEY",
      "google_api_key",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "RESEND_API_KEY",
      "JWT_SECRET",
      "COOKIE_SECRET",
      "POSTGRES_PASSWORD",
      "apiKey",
      "api_key",
      "clientSecret",
      "client_secret",
      "password",
      "password_hash",
      "secret",
      // Error details que pueden contener SQL values / stack-locals
      "err.config",
      "err.request",
      "err.response.config",
      "err.response.data.token",
      "err.response.data.password",
    ],
    censor: "[REDACTED]",
  },
  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
      },
});
