// Delivery service: dado un evento + payload, busca todas las destinations
// que matchean, las dispara en paralelo y registra cada delivery en DB.
//
// Diseñado para fire-and-forget desde el código que emite eventos: NO bloquea
// el flujo principal si algo falla en una integración externa.
//
// MT-3: ahora scoped al tenant. emitEvent y emitEventFireAndForget reciben
// tenantId como primer parámetro. Para callers que no tienen contexto HTTP
// (crons, workers) se pasa "default" con TODO MT-6.
import { query } from "../../database/db";
import { logger } from "../../utils/logger";
import {
  listDestinations, recordDelivery, destinationMatches,
} from "./destinations.service";
import { deliverWebhook, deliverSlack, deliverEmail, deliverSap, type DeliveryResult } from "./adapters";
import type {
  WebhookConfig, SlackConfig, EmailConfig, SapConfig, IntegrationDelivery,
} from "../../types/integration.types";

async function recordDeliveryRow(
  tenantId: string,
  destinationId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
  result: DeliveryResult
): Promise<void> {
  try {
    await query(
      `INSERT INTO integration_deliveries
         (tenant_id, destination_id, event_type, payload, status, http_status, response_excerpt, attempts, last_attempted_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 1, now())`,
      [
        tenantId,
        destinationId,
        eventType,
        JSON.stringify(payload),
        result.ok ? "sent" : "failed",
        result.httpStatus ?? null,
        (result.responseExcerpt ?? result.error ?? "").slice(0, 800),
      ]
    );
  } catch (err) {
    logger.warn({ err, eventType }, "integration_deliveries insert fail");
  }
}

// Emite un evento de forma asíncrona. NO esperamos al resultado en el caller
// (el código de Mesa de Soporte / meetings no debe quedarse esperando).
// Devuelve la promise por si el caller quiere awaitarla en tests.
export async function emitEvent(
  tenantId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  let destinations;
  try {
    destinations = await listDestinations(tenantId);
  } catch (err) {
    logger.warn({ err, eventType, tenantId }, "no se pudo listar destinations");
    return;
  }
  const matching = destinations.filter((d) => destinationMatches(d, eventType));
  if (matching.length === 0) return;

  logger.info({ eventType, tenantId, count: matching.length }, "integration emit");

  const payload = {
    event: eventType,
    timestamp: new Date().toISOString(),
    data,
  };

  // Disparar en paralelo, sin awaiter desde el caller original
  await Promise.allSettled(
    matching.map(async (d) => {
      let result: DeliveryResult;
      try {
        if (d.type === "webhook") result = await deliverWebhook(d.config as WebhookConfig, payload);
        else if (d.type === "slack") result = await deliverSlack(d.config as SlackConfig, payload);
        else if (d.type === "email") result = await deliverEmail(d.config as EmailConfig, payload);
        else if (d.type === "sap")   result = await deliverSap(d.config as SapConfig, payload);
        else result = { ok: false, error: `tipo desconocido: ${d.type}` };
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : "adapter error" };
      }
      await recordDeliveryRow(tenantId, d.id, eventType, payload, result);
      await recordDelivery(tenantId, d.id, result.ok, result.error);
    })
  );
}

// Fire-and-forget para llamar desde código de negocio sin bloquear.
// tenantId es opcional: si no se provee, se usa "default" con warning para forensics.
// TODO MT-6: ningún caller debería omitir tenantId — cuando todos pasen el suyo,
// removemos el branch default.
export function emitEventFireAndForget(
  tenantId: string | null | undefined,
  eventType: string,
  data: Record<string, unknown>,
): void {
  let safeTenant = tenantId;
  if (!safeTenant) {
    safeTenant = "default";
    logger.warn({ eventType }, "emitEventFireAndForget sin tenantId → usando 'default' (TODO MT-6 scope)");
  }
  emitEvent(safeTenant, eventType, data).catch((err) => {
    logger.warn({ err, eventType, tenantId: safeTenant }, "emit fire-and-forget unhandled");
  });
}

// Envío de prueba a una destination específica (sin filtros).
export async function testDestination(tenantId: string, destinationId: string): Promise<DeliveryResult> {
  const { rows } = await query<{ id: string; type: string; config: unknown }>(
    `SELECT id, type, config FROM integration_destinations WHERE id = $1 AND tenant_id = $2`,
    [destinationId, tenantId]
  );
  const d = rows[0];
  if (!d) return { ok: false, error: "destination no encontrada" };
  const payload = {
    event: "test",
    timestamp: new Date().toISOString(),
    data: {
      title: "Mensaje de prueba",
      message: "Si ves esto, la integración está conectada correctamente.",
      project: "supply-chain-ams-agent",
    },
  };
  let result: DeliveryResult;
  try {
    if (d.type === "webhook")    result = await deliverWebhook(d.config as WebhookConfig, payload);
    else if (d.type === "slack") result = await deliverSlack(d.config as SlackConfig, payload);
    else if (d.type === "email") result = await deliverEmail(d.config as EmailConfig, payload);
    else if (d.type === "sap")   result = await deliverSap(d.config as SapConfig, payload);
    else result = { ok: false, error: `tipo desconocido: ${d.type}` };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : "adapter error" };
  }
  await recordDeliveryRow(tenantId, d.id, "test", payload, result);
  await recordDelivery(tenantId, d.id, result.ok, result.error);
  return result;
}

export async function listDeliveries(tenantId: string, filters: {
  destinationId?: string;
  status?: "pending" | "sent" | "failed";
  eventType?: string;
  limit?: number;
} = {}): Promise<IntegrationDelivery[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  // Tenant scoping siempre primero.
  params.push(tenantId);
  conds.push(`tenant_id = $${params.length}`);
  if (filters.destinationId) { params.push(filters.destinationId); conds.push(`destination_id = $${params.length}`); }
  if (filters.status)        { params.push(filters.status);         conds.push(`status = $${params.length}`); }
  if (filters.eventType)     { params.push(filters.eventType);      conds.push(`event_type = $${params.length}`); }
  const where = `WHERE ${conds.join(" AND ")}`;
  const limit = Math.min(filters.limit ?? 100, 500);
  params.push(limit);
  const { rows } = await query<IntegrationDelivery>(
    `SELECT * FROM integration_deliveries ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return rows;
}
