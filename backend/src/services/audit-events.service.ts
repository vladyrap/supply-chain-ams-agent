// =============================================================================
// audit-events.service.ts — Audit Trail rico (DH v0.9)
// =============================================================================
// Reemplaza progresivamente a audit.service.ts (audit_logs). Schema rico,
// filtrable, con índices, soporta ticket-scoped y sistema-wide.
//
// Es idempotente: si la tabla no existe, intenta crearla (best-effort) en la
// primera escritura. En producción se crea con la migración SQL al hacer
// `docker compose up` (init.sql + migrations/ ejecutadas).
// =============================================================================

import { query } from "../database/db";
import { logger } from "../utils/logger";
import type {
  AuditEventInput, AuditEventRecord, AuditEventFilters, AuditEventSummary,
} from "../types/audit-events.types";

let schemaEnsured = false;

/** Crea la tabla y los índices si no existen (best-effort, idempotente). */
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       TEXT,
        ticket_id       TEXT,
        actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
        actor_name      TEXT,
        actor_role      TEXT,
        event_type      TEXT NOT NULL,
        category        TEXT NOT NULL DEFAULT 'general',
        severity        TEXT NOT NULL DEFAULT 'info',
        payload         JSONB,
        source          TEXT NOT NULL DEFAULT 'ui',
        correlation_id  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_ticket     ON audit_events(ticket_id) WHERE ticket_id IS NOT NULL;`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_type       ON audit_events(event_type);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_category   ON audit_events(category);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_severity   ON audit_events(severity);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_actor      ON audit_events(actor_user_id) WHERE actor_user_id IS NOT NULL;`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_events_correlation ON audit_events(correlation_id) WHERE correlation_id IS NOT NULL;`);

    // v0.12.1 — dedup constraint para evitar la duplicación masiva
    // (16k duplicados observados el 2026-06-05 por bug del frontend).
    // Función IMMUTABLE wrapper sobre EXTRACT(EPOCH) + partial unique index.
    // Idempotente. Detalle: date_trunc(TIMESTAMPTZ) NO es immutable → usamos epoch.
    await query(`
      CREATE OR REPLACE FUNCTION audit_events_minute_bucket(ts TIMESTAMPTZ)
      RETURNS BIGINT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
        SELECT EXTRACT(EPOCH FROM ts)::bigint / 60;
      $$;
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_events_dedup_minute
        ON audit_events (event_type, ticket_id, audit_events_minute_bucket(created_at))
        WHERE ticket_id IS NOT NULL;
    `);

    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure audit_events schema failed (best-effort)");
  }
}

function rowToRecord(row: {
  id: string; tenant_id: string | null; ticket_id: string | null;
  actor_user_id: string | null; actor_name: string | null; actor_role: string | null;
  event_type: string; category: string; severity: string;
  payload: unknown; source: string; correlation_id: string | null;
  created_at: string;
}): AuditEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ticketId: row.ticket_id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    eventType: row.event_type,
    category: row.category,
    severity: row.severity,
    payload: row.payload,
    source: row.source,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
}

/**
 * Registra un evento. Devuelve el record persistido (con id) o null si falló.
 * Nunca throws — es best-effort para no romper flujos.
 */
export async function recordAuditEvent(input: AuditEventInput): Promise<AuditEventRecord | null> {
  await ensureSchema();
  try {
    const { rows } = await query<Parameters<typeof rowToRecord>[0]>(
      `INSERT INTO audit_events (
        tenant_id, ticket_id, actor_user_id, actor_name, actor_role,
        event_type, category, severity, payload, source, correlation_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
      RETURNING id, tenant_id, ticket_id, actor_user_id, actor_name, actor_role,
                event_type, category, severity, payload, source, correlation_id,
                created_at`,
      [
        input.tenantId ?? null,
        input.ticketId ?? null,
        input.actorUserId ?? null,
        input.actorName ?? null,
        input.actorRole ?? null,
        input.eventType,
        input.category ?? "general",
        input.severity ?? "info",
        input.payload ? JSON.stringify(input.payload) : null,
        input.source ?? "ui",
        input.correlationId ?? null,
      ]
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  } catch (err) {
    // v0.12.1 — manejar dedup violation gracefully:
    // si el INSERT falla por uq_audit_events_dedup_minute (PostgreSQL 23505),
    // devolvemos el evento existente del mismo (event_type, ticket_id, minuto).
    // El cliente nunca ve el conflicto, just queda idempotente.
    const errCode = (err as { code?: string } | null)?.code;
    if (errCode === "23505" && input.ticketId) {
      try {
        const { rows: existing } = await query<Parameters<typeof rowToRecord>[0]>(
          `SELECT id, tenant_id, ticket_id, actor_user_id, actor_name, actor_role,
                  event_type, category, severity, payload, source, correlation_id,
                  created_at
             FROM audit_events
            WHERE event_type = $1
              AND ticket_id = $2
              AND audit_events_minute_bucket(created_at) = audit_events_minute_bucket(now())
            ORDER BY created_at DESC
            LIMIT 1`,
          [input.eventType, input.ticketId],
        );
        if (existing[0]) {
          logger.debug(
            { eventType: input.eventType, ticketId: input.ticketId },
            "audit_events dedup: returning existing record (within same minute)",
          );
          return rowToRecord(existing[0]);
        }
      } catch (selectErr) {
        logger.warn({ selectErr }, "audit_events dedup fallback select failed");
      }
    }
    logger.error({ err, eventType: input.eventType }, "audit_events insert failed");
    return null;
  }
}

/** Lista eventos con filtros + paginación. */
export async function listAuditEvents(filters: AuditEventFilters = {}): Promise<AuditEventRecord[]> {
  await ensureSchema();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (filters.ticketId)    { conditions.push(`ticket_id = $${i++}`);    params.push(filters.ticketId); }
  if (filters.eventType)   { conditions.push(`event_type = $${i++}`);   params.push(filters.eventType); }
  if (filters.category)    { conditions.push(`category = $${i++}`);     params.push(filters.category); }
  if (filters.severity)    { conditions.push(`severity = $${i++}`);     params.push(filters.severity); }
  if (filters.actorUserId) { conditions.push(`actor_user_id = $${i++}`); params.push(filters.actorUserId); }
  if (filters.fromDate)    { conditions.push(`created_at >= $${i++}`);  params.push(filters.fromDate); }
  if (filters.toDate)      { conditions.push(`created_at <= $${i++}`);  params.push(filters.toDate); }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 100, 500);
  const offset = filters.offset ?? 0;

  try {
    const { rows } = await query<Parameters<typeof rowToRecord>[0]>(
      `SELECT id, tenant_id, ticket_id, actor_user_id, actor_name, actor_role,
              event_type, category, severity, payload, source, correlation_id,
              created_at
         FROM audit_events
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
      [...params, limit, offset]
    );
    return rows.map(rowToRecord);
  } catch (err) {
    logger.error({ err }, "audit_events list failed");
    return [];
  }
}

/** Lista eventos de un ticket específico, ordenados por created_at ASC (timeline). */
export async function getAuditByTicket(ticketKey: string, limit = 500): Promise<AuditEventRecord[]> {
  await ensureSchema();
  try {
    const { rows } = await query<Parameters<typeof rowToRecord>[0]>(
      `SELECT id, tenant_id, ticket_id, actor_user_id, actor_name, actor_role,
              event_type, category, severity, payload, source, correlation_id,
              created_at
         FROM audit_events
        WHERE ticket_id = $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [ticketKey, Math.min(limit, 1000)]
    );
    return rows.map(rowToRecord);
  } catch (err) {
    logger.error({ err, ticketKey }, "audit_events byTicket failed");
    return [];
  }
}

/** Resumen agregado para dashboard de auditoría. */
export async function getAuditSummary(): Promise<AuditEventSummary> {
  await ensureSchema();
  try {
    const [total, byCat, bySev, byType, last7d, last24h] = await Promise.all([
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM audit_events`),
      query<{ category: string; c: string }>(`SELECT category, COUNT(*)::text AS c FROM audit_events GROUP BY category`),
      query<{ severity: string; c: string }>(`SELECT severity, COUNT(*)::text AS c FROM audit_events GROUP BY severity`),
      query<{ event_type: string; c: string }>(`SELECT event_type, COUNT(*)::text AS c FROM audit_events GROUP BY event_type ORDER BY COUNT(*) DESC LIMIT 20`),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM audit_events WHERE created_at > now() - interval '7 days'`),
      query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM audit_events WHERE created_at > now() - interval '24 hours'`),
    ]);

    const byCategory: Record<string, number> = {};
    for (const r of byCat.rows) byCategory[r.category] = Number(r.c);

    const bySeverity: Record<string, number> = {};
    for (const r of bySev.rows) bySeverity[r.severity] = Number(r.c);

    return {
      total: Number(total.rows[0]?.c ?? 0),
      byCategory,
      bySeverity,
      byEventType: byType.rows.map((r) => ({ eventType: r.event_type, count: Number(r.c) })),
      last7Days: Number(last7d.rows[0]?.c ?? 0),
      last24h: Number(last24h.rows[0]?.c ?? 0),
    };
  } catch (err) {
    logger.error({ err }, "audit_events summary failed");
    return {
      total: 0, byCategory: {}, bySeverity: {}, byEventType: [], last7Days: 0, last24h: 0,
    };
  }
}
