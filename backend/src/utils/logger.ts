import pino from "pino";

const isProd = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "ANTHROPIC_API_KEY",
      "anthropic_api_key",
      "GEMINI_API_KEY",
      "gemini_api_key",
      "GOOGLE_API_KEY",
      "google_api_key",
      "apiKey",
      "api_key",
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
