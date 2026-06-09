// =============================================================================
// tenants.service.ts — Catálogo de tenants (v1.2.0)
// =============================================================================
// Multi-tenant foundation: CRUD del catálogo `tenants`.
// Acceso restringido a super_admin (role 'admin' con tenantId='*' efectivo).
// =============================================================================

import { query } from "../database/db";
import { logger } from "../utils/logger";

export type TenantPlan = "starter" | "standard" | "premium" | "enterprise";
export type TenantStatus = "active" | "trial" | "suspended" | "deleted";

export interface TenantBrand {
  logo?: string;       // URL al logo (PNG/SVG)
  accent?: string;     // Hex color (#22d3ee)
  name?: string;       // Display name del cliente
}

export interface TenantSettings {
  timezone?: string;       // ej "America/Santiago"
  locale?: string;         // ej "es-CL"
  currency?: string;       // ej "CLP"
  signature?: string;      // firma default en customer responses
  [k: string]: unknown;
}

export interface TenantRecord {
  id: string;
  name: string;
  subdomain: string | null;
  plan: TenantPlan;
  status: TenantStatus;
  brand: TenantBrand;
  settings: TenantSettings;
  monthlyQuotaTickets: number | null;
  monthlyQuotaGeminiUsd: number | null;
  createdAt: string;
  updatedAt: string;
  trialEndsAt: string | null;
}

export interface CreateTenantInput {
  id: string;                  // slug del tenant (ej "acme")
  name: string;
  subdomain?: string;          // si distinto del id
  plan?: TenantPlan;
  status?: TenantStatus;
  brand?: TenantBrand;
  settings?: TenantSettings;
  monthlyQuotaTickets?: number;
  monthlyQuotaGeminiUsd?: number;
  trialEndsAt?: string;
}

export interface UpdateTenantInput {
  name?: string;
  subdomain?: string;
  plan?: TenantPlan;
  status?: TenantStatus;
  brand?: TenantBrand;
  settings?: TenantSettings;
  monthlyQuotaTickets?: number | null;
  monthlyQuotaGeminiUsd?: number | null;
  trialEndsAt?: string | null;
}

interface TenantRow {
  id: string;
  name: string;
  subdomain: string | null;
  plan: string;
  status: string;
  brand: unknown;
  settings: unknown;
  monthly_quota_tickets: number | null;
  monthly_quota_gemini_usd: string | null; // pg returns numeric as string
  created_at: string;
  updated_at: string;
  trial_ends_at: string | null;
}

function rowToRecord(r: TenantRow): TenantRecord {
  return {
    id: r.id,
    name: r.name,
    subdomain: r.subdomain,
    plan: r.plan as TenantPlan,
    status: r.status as TenantStatus,
    brand: (r.brand as TenantBrand) ?? {},
    settings: (r.settings as TenantSettings) ?? {},
    monthlyQuotaTickets: r.monthly_quota_tickets,
    monthlyQuotaGeminiUsd: r.monthly_quota_gemini_usd ? Number(r.monthly_quota_gemini_usd) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    trialEndsAt: r.trial_ends_at,
  };
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
function validateSlug(id: string): void {
  if (!SLUG_REGEX.test(id)) {
    throw new Error(`Tenant id inválido: "${id}". Debe ser 3-64 chars [a-z0-9-], no empezar/terminar con guión.`);
  }
}

/** Lista todos los tenants (super_admin only en el controller). */
export async function listTenants(opts: { includeDeleted?: boolean } = {}): Promise<TenantRecord[]> {
  const where = opts.includeDeleted ? "" : "WHERE status != 'deleted'";
  const { rows } = await query<TenantRow>(
    `SELECT id, name, subdomain, plan, status, brand, settings,
            monthly_quota_tickets, monthly_quota_gemini_usd,
            created_at::text, updated_at::text, trial_ends_at::text
       FROM tenants ${where}
       ORDER BY created_at ASC`,
  );
  return rows.map(rowToRecord);
}

/** Obtiene un tenant por id. Devuelve null si no existe o está deleted. */
export async function getTenant(id: string, opts: { includeDeleted?: boolean } = {}): Promise<TenantRecord | null> {
  const where = opts.includeDeleted ? "WHERE id = $1" : "WHERE id = $1 AND status != 'deleted'";
  const { rows } = await query<TenantRow>(
    `SELECT id, name, subdomain, plan, status, brand, settings,
            monthly_quota_tickets, monthly_quota_gemini_usd,
            created_at::text, updated_at::text, trial_ends_at::text
       FROM tenants ${where}`,
    [id],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Crea un tenant nuevo. */
export async function createTenant(input: CreateTenantInput): Promise<TenantRecord> {
  validateSlug(input.id);
  if (input.subdomain) validateSlug(input.subdomain);
  try {
    const { rows } = await query<TenantRow>(
      `INSERT INTO tenants (id, name, subdomain, plan, status, brand, settings,
                            monthly_quota_tickets, monthly_quota_gemini_usd, trial_ends_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
       RETURNING id, name, subdomain, plan, status, brand, settings,
                 monthly_quota_tickets, monthly_quota_gemini_usd,
                 created_at::text, updated_at::text, trial_ends_at::text`,
      [
        input.id,
        input.name,
        input.subdomain ?? null,
        input.plan ?? "standard",
        input.status ?? "trial",
        JSON.stringify(input.brand ?? {}),
        JSON.stringify(input.settings ?? {}),
        input.monthlyQuotaTickets ?? null,
        input.monthlyQuotaGeminiUsd ?? null,
        input.trialEndsAt ?? null,
      ],
    );
    if (!rows[0]) throw new Error("createTenant: INSERT no devolvió row");
    logger.info({ tenantId: input.id, plan: input.plan }, "tenant created");
    return rowToRecord(rows[0]);
  } catch (err) {
    const errAny = err as { code?: string; constraint?: string; message?: string };
    if (errAny.code === "23505") {
      throw new Error(`Tenant ya existe: "${input.id}" (o subdomain "${input.subdomain}" ya tomado)`);
    }
    throw err;
  }
}

/** Update parcial de un tenant. */
export async function updateTenant(id: string, input: UpdateTenantInput): Promise<TenantRecord | null> {
  // Build dynamic SET clause solo con campos provistos
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (input.name !== undefined) { sets.push(`name = $${i++}`); params.push(input.name); }
  if (input.subdomain !== undefined) {
    if (input.subdomain) validateSlug(input.subdomain);
    sets.push(`subdomain = $${i++}`);
    params.push(input.subdomain || null);
  }
  if (input.plan !== undefined) { sets.push(`plan = $${i++}`); params.push(input.plan); }
  if (input.status !== undefined) { sets.push(`status = $${i++}`); params.push(input.status); }
  if (input.brand !== undefined) { sets.push(`brand = $${i++}::jsonb`); params.push(JSON.stringify(input.brand)); }
  if (input.settings !== undefined) { sets.push(`settings = $${i++}::jsonb`); params.push(JSON.stringify(input.settings)); }
  if (input.monthlyQuotaTickets !== undefined) { sets.push(`monthly_quota_tickets = $${i++}`); params.push(input.monthlyQuotaTickets); }
  if (input.monthlyQuotaGeminiUsd !== undefined) { sets.push(`monthly_quota_gemini_usd = $${i++}`); params.push(input.monthlyQuotaGeminiUsd); }
  if (input.trialEndsAt !== undefined) { sets.push(`trial_ends_at = $${i++}`); params.push(input.trialEndsAt); }

  if (sets.length === 0) return getTenant(id);

  sets.push(`updated_at = now()`);
  params.push(id);

  const { rows } = await query<TenantRow>(
    `UPDATE tenants SET ${sets.join(", ")} WHERE id = $${i}
       RETURNING id, name, subdomain, plan, status, brand, settings,
                 monthly_quota_tickets, monthly_quota_gemini_usd,
                 created_at::text, updated_at::text, trial_ends_at::text`,
    params,
  );
  if (!rows[0]) return null;
  logger.info({ tenantId: id, fields: Object.keys(input) }, "tenant updated");
  return rowToRecord(rows[0]);
}

/**
 * "Borrar" tenant = marcar status='deleted' (soft delete).
 * NO permite hard delete porque hay FK RESTRICT desde todas las tablas data.
 * Para hard delete: primero borrar manualmente toda la data del tenant.
 */
export async function softDeleteTenant(id: string): Promise<boolean> {
  if (id === "default") {
    throw new Error("No se puede borrar el tenant 'default'");
  }
  const { rowCount } = await query(
    `UPDATE tenants SET status = 'deleted', updated_at = now() WHERE id = $1 AND status != 'deleted'`,
    [id],
  );
  logger.warn({ tenantId: id }, "tenant soft-deleted");
  return rowCount > 0;
}

/** Resuelve tenant por subdomain — usado por el middleware tenant. */
export async function getTenantBySubdomain(subdomain: string): Promise<TenantRecord | null> {
  const { rows } = await query<TenantRow>(
    `SELECT id, name, subdomain, plan, status, brand, settings,
            monthly_quota_tickets, monthly_quota_gemini_usd,
            created_at::text, updated_at::text, trial_ends_at::text
       FROM tenants
      WHERE subdomain = $1 AND status IN ('active','trial')`,
    [subdomain.toLowerCase()],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}
