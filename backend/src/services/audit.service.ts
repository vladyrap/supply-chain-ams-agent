import { query } from "../database/db";
import { logger } from "../utils/logger";
import type { AuditAction, AuditLogRecord } from "../types/ams.types";

export async function recordAudit(
  action: AuditAction,
  details: Record<string, unknown> = {}
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (action, details) VALUES ($1, $2::jsonb)`,
      [action, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error({ err, action }, "No se pudo guardar audit_log");
  }
}

export async function listAudit(limit = 100): Promise<AuditLogRecord[]> {
  const { rows } = await query<AuditLogRecord>(
    `SELECT id, action, details, created_at
       FROM audit_logs
       ORDER BY created_at DESC
       LIMIT $1`,
    [limit]
  );
  return rows;
}
