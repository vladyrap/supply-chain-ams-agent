// Delivery service: dado un evento + payload, busca todas las destinations
// que matchean, las dispara en paralelo y registra cada delivery en DB.
//
// Diseñado para fire-and-forget desde el código que emite eventos: NO bloquea
// el flujo principal si algo falla en una integración externa.
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
  destinationId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
  result: DeliveryResult
): Promise<void> {
  try {
    await query(
      `INSERT INTO integration_deliveries
         (destination_id, event_type, payload, status, http_status, response_excerpt, attempts, last_attempted_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, 1, now())`,
      [
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
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  let destinations;
  try {
    destinations = await listDestinations();
  } catch (err) {
    logger.warn({ err, eventType }, "no se pudo listar destinations");
    return;
  }
  const matching = destinations.filter((d) => destinationMatches(d, eventType));
  if (matching.length === 0) return;

  logger.info({ eventType, count: matching.length }, "integration emit");

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
      await recordDeliveryRow(d.id, eventType, payload, result);
      await recordDelivery(d.id, result.ok, result.error);
    })
  );
}

// Fire-and-forget para llamar desde código de negocio sin bloquear.
export function emitEventFireAndForget(eventType: string, data: Record<string, unknown>): void {
  emitEvent(eventType, data).catch((err) => {
    logger.warn({ err, eventType }, "emit fire-and-forget unhandled");
  });
}

// Envío de prueba a una destination específica (sin filtros).
export async function testDestination(destinationId: string): Promise<DeliveryResult> {
  const { rows } = await query<{ id: string; type: string; config: unknown }>(
    `SELECT id, type, config FROM integration_destinations WHERE id = $1`,
    [destinationId]
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
  await recordDeliveryRow(d.id, "test", payload, result);
  await recordDelivery(d.id, result.ok, result.error);
  return result;
}

export async function listDeliveries(filters: {
  destinationId?: string;
  status?: "pending" | "sent" | "failed";
  eventType?: string;
  limit?: number;
} = {}): Promise<IntegrationDelivery[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.destinationId) { params.push(filters.destinationId); conds.push(`destination_id = $${params.length}`); }
  if (filters.status)        { params.push(filters.status);         conds.push(`status = $${params.length}`); }
  if (filters.eventType)     { params.push(filters.eventType);      conds.push(`event_type = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
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
