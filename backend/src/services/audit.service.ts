import { query } from "../database/db";
import { logger } from "../utils/logger";
import type { AuditAction, AuditLogRecord } from "../types/ams.types";

// =============================================================================
// audit.service.ts — Audit log LEGACY (audit_logs) tenant-scoped
// =============================================================================
// FIX G1 (audit v1.2.0): INSERT incluía tenant_id NULL → NOT NULL violation
// post-migration 005. SELECT era global cross-tenant.
// Mantenido como compat layer; el audit "rico" nuevo está en audit-events.service.
// =============================================================================

/**
 * recordAudit — backwards compatible:
 *   - Nueva firma: recordAudit(tenantId, action, details)
 *   - Compat firma vieja: recordAudit(action, details) → tenant='default' + warn
 *   Permite migrar callsites progresivamente sin romper.
 */
export async function recordAudit(
  tenantIdOrAction: string,
  actionOrDetails?: AuditAction | Record<string, unknown>,
  details: Record<string, unknown> = {}
): Promise<void> {
  // Detectar firma: si el 2do arg es string → firma nueva (tenantId, action, details)
  //                 si es objeto → firma legacy (action, details)
  let tenantId: string;
  let action: AuditAction;
  let payload: Record<string, unknown>;
  if (typeof actionOrDetails === "string") {
    tenantId = tenantIdOrAction;
    action = actionOrDetails as AuditAction;
    payload = details;
  } else {
    // Legacy: cae a 'default' + log warning para detectar callsites no migrados
    tenantId = "default";
    action = tenantIdOrAction as AuditAction;
    payload = (actionOrDetails as Record<string, unknown>) ?? {};
    logger.warn({ action }, "recordAudit legacy signature — defaultTenant fallback (TODO migrar a (tenantId, action, details))");
  }

  try {
    await query(
      `INSERT INTO audit_logs (tenant_id, action, details) VALUES ($1, $2, $3::jsonb)`,
      [tenantId, action, JSON.stringify(payload)]
    );
  } catch (err) {
    logger.error({ err, action, tenantId }, "No se pudo guardar audit_log");
  }
}

/** Lista los últimos N audit logs DEL TENANT. */
export async function listAudit(tenantId: string, limit = 100): Promise<AuditLogRecord[]> {
  const { rows } = await query<AuditLogRecord>(
    `SELECT id, action, details, created_at
       FROM audit_logs
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [tenantId, limit]
  );
  return rows;
}
