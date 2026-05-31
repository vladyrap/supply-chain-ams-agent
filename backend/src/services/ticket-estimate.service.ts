// Servicio backend de autoestimación de tickets/incidentes.
// - Migración idempotente: agrega columna estimated_resolution jsonb si no existe.
// - enrichIncident/enrichTicket: enriquecen la fila con la estimación generada.
// - Lazy backfill: si una fila no tiene estimación al ser leída, se calcula y persiste.

import { query } from "../database/db";
import { logger } from "../utils/logger";
import {
  autoEstimateTicketResolution,
  buildInputFromIncidentRow,
  type TicketEstimatedResolution,
  type TicketEstimateInput,
} from "../utils/estimation";

let schemaReady = false;

/**
 * Idempotente: agrega columna `estimated_resolution jsonb` a las tablas
 * incidents, support_tickets y escalation_records si todavía no existe.
 * Postgres soporta `ADD COLUMN IF NOT EXISTS` desde 9.6.
 */
export async function ensureEstimateSchema(): Promise<void> {
  if (schemaReady) return;
  try {
    await query(`ALTER TABLE incidents          ADD COLUMN IF NOT EXISTS estimated_resolution jsonb;`);
    // support_tickets y escalation_records son creadas en runtime por sus services.
    // Las migramos best-effort — si todavía no existen, el ALTER fallará y lo capturamos.
    try { await query(`ALTER TABLE support_tickets    ADD COLUMN IF NOT EXISTS estimated_resolution jsonb;`); } catch { /* tabla no existe aún */ }
    try { await query(`ALTER TABLE escalation_records ADD COLUMN IF NOT EXISTS estimated_resolution jsonb;`); } catch { /* idem */ }
    schemaReady = true;
  } catch (err) {
    logger.warn({ err }, "ensure estimate schema failed");
  }
}

/**
 * Persiste la estimación calculada para un incidente.
 * UPDATE solo de la columna estimated_resolution — no toca el resto del row.
 */
export async function persistIncidentEstimate(
  incidentId: string,
  estimate: TicketEstimatedResolution,
): Promise<void> {
  await ensureEstimateSchema();
  await query(
    `UPDATE incidents SET estimated_resolution = $1::jsonb WHERE id = $2`,
    [JSON.stringify(estimate), incidentId]
  );
}

/**
 * Si el incidente no tiene estimación, la genera y persiste.
 * Idempotente. Devuelve la estimación (nueva o existente).
 */
export async function enrichIncidentLazy(row: {
  id: string;
  message: string;
  sap_module: string | null;
  environment: string | null;
  confidence: string | null;
  attachments: unknown;
  estimated_resolution?: TicketEstimatedResolution | null;
}): Promise<TicketEstimatedResolution> {
  if (row.estimated_resolution) return row.estimated_resolution;
  await ensureEstimateSchema();
  const input = buildInputFromIncidentRow(row);
  const est = autoEstimateTicketResolution(input);
  // No bloqueamos el GET por una falla de persistencia
  persistIncidentEstimate(row.id, est).catch((err) =>
    logger.warn({ err, incidentId: row.id }, "persist estimate failed")
  );
  return est;
}

/**
 * Estima sin persistir — útil cuando se crea el incidente en la misma
 * transacción y se quiere meter la estimación en el primer INSERT.
 */
export function estimateIncident(input: TicketEstimateInput): TicketEstimatedResolution {
  return autoEstimateTicketResolution(input);
}
