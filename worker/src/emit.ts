// Emit cross-service: el worker llama al backend para que dispare integraciones.
// FIX G5 MT v1.2.0: ahora acepta tenantId como 1er param y lo manda en payload.
// Header X-Tenant-Bypass dejaría que el middleware tenant del backend lo
// respete (super_admin-like). En la práctica, /api/integrations/emit lee
// data.tenant_id del body para scopear destinations.
import { logger } from "./logger";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://supply-chain-ams-backend:8000";
const WORKER_CSRF_BYPASS = process.env.WORKER_CSRF_BYPASS_TOKEN || "";

export async function emitEvent(
  tenantId: string,
  eventType: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Tenant-Id": tenantId,
    };
    if (WORKER_CSRF_BYPASS) headers["X-Csrf-Bypass"] = WORKER_CSRF_BYPASS;
    const res = await fetch(`${BACKEND_URL}/api/integrations/emit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tenantId, eventType, data }),
    });
    if (!res.ok) {
      logger.warn({ eventType, tenantId, status: res.status }, "emit cross-service no OK");
    }
  } catch (err) {
    logger.warn({ err, eventType, tenantId }, "emit cross-service fail (sigo, no es crítico)");
  }
}
