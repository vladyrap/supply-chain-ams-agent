import { query } from "../../database/db";
import type {
  IntegrationDestination, DestinationType, DestinationConfig,
} from "../../types/integration.types";

export interface CreateDestinationInput {
  name: string;
  type: DestinationType;
  config: DestinationConfig;
  event_filter?: string[];
  active?: boolean;
  created_by?: string;
}

export async function createDestination(tenantId: string, input: CreateDestinationInput): Promise<IntegrationDestination> {
  const { rows } = await query<IntegrationDestination>(
    `INSERT INTO integration_destinations
       (tenant_id, name, type, config, event_filter, active, created_by, last_status)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'never')
     RETURNING *`,
    [
      tenantId,
      input.name,
      input.type,
      JSON.stringify(input.config),
      input.event_filter && input.event_filter.length > 0 ? input.event_filter : ["*"],
      input.active ?? true,
      input.created_by ?? null,
    ]
  );
  return rows[0]!;
}

export async function listDestinations(tenantId: string): Promise<IntegrationDestination[]> {
  const { rows } = await query<IntegrationDestination>(
    `SELECT * FROM integration_destinations WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return rows;
}

export async function getDestinationById(tenantId: string, id: string): Promise<IntegrationDestination | null> {
  const { rows } = await query<IntegrationDestination>(
    `SELECT * FROM integration_destinations WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export interface UpdateDestinationInput {
  name?: string;
  config?: DestinationConfig;
  event_filter?: string[];
  active?: boolean;
}

export async function updateDestination(tenantId: string, id: string, input: UpdateDestinationInput): Promise<IntegrationDestination | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown, cast = "") => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (input.name !== undefined) push("name", input.name);
  if (input.config !== undefined) push("config", JSON.stringify(input.config), "::jsonb");
  if (input.event_filter !== undefined) push("event_filter", input.event_filter);
  if (input.active !== undefined) push("active", input.active);
  if (sets.length === 0) return getDestinationById(tenantId, id);
  sets.push(`updated_at = now()`);
  params.push(id);
  const idIdx = params.length;
  params.push(tenantId);
  const tenantIdx = params.length;
  const { rows } = await query<IntegrationDestination>(
    `UPDATE integration_destinations SET ${sets.join(", ")} WHERE id = $${idIdx} AND tenant_id = $${tenantIdx} RETURNING *`,
    params
  );
  return rows[0] ?? null;
}

export async function deleteDestination(tenantId: string, id: string): Promise<boolean> {
  const res = await query(`DELETE FROM integration_destinations WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return res.rowCount > 0;
}

// Actualiza estadísticas después de un envío. Scoped al tenant para evitar
// que un delivery cross-tenant actualice destinations ajenas.
export async function recordDelivery(
  tenantId: string,
  destinationId: string,
  ok: boolean,
  error?: string
): Promise<void> {
  await query(
    `UPDATE integration_destinations
        SET delivery_count = delivery_count + 1,
            error_count = error_count + $1,
            last_used_at = now(),
            last_status = $2,
            last_error = $3
      WHERE id = $4 AND tenant_id = $5`,
    [ok ? 0 : 1, ok ? "ok" : "error", error ?? null, destinationId, tenantId]
  );
}

// Match de un evento contra los patrones del filtro. Soporta "*", "prefix.*"
// y match exacto.
export function destinationMatches(d: IntegrationDestination, eventType: string): boolean {
  if (!d.active) return false;
  if (!d.event_filter || d.event_filter.length === 0) return true;
  for (const f of d.event_filter) {
    if (f === "*") return true;
    if (f === eventType) return true;
    if (f.endsWith(".*")) {
      const prefix = f.slice(0, -2);
      if (eventType.startsWith(prefix + ".")) return true;
    }
  }
  return false;
}
