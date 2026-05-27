// Emit cross-service: el worker llama al backend para que dispare integraciones.
// Evitamos duplicar la lógica de delivery acá.
import { logger } from "./logger";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://supply-chain-ams-backend:8000";

export async function emitEvent(eventType: string, data: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/integrations/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType, data }),
    });
    if (!res.ok) {
      logger.warn({ eventType, status: res.status }, "emit cross-service no OK");
    }
  } catch (err) {
    logger.warn({ err, eventType }, "emit cross-service fail (sigo, no es crítico)");
  }
}
