// Sentry init para backend. Sólo activo si SENTRY_DSN está seteada.
// Si está vacía, todas las funciones son no-op.

import * as Sentry from "@sentry/node";
import { logger } from "./logger";

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || "development",
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.05),
      release: process.env.SENTRY_RELEASE,
      // No enviar PII por default
      sendDefaultPii: false,
    });
    initialized = true;
    logger.info("Sentry inicializado (backend)");
  } catch (err) {
    logger.warn({ err }, "Sentry init failed");
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      if (context) {
        for (const [k, v] of Object.entries(context)) scope.setExtra(k, v);
      }
      Sentry.captureException(err);
    });
  } catch { /* swallow */ }
}

export { Sentry };
