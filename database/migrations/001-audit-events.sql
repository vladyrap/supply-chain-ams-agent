-- =============================================================================
-- 001-audit-events.sql — DH v0.9
-- =============================================================================
-- Crea la tabla audit_events con schema rico para auditoría de demo hardening.
-- NO toca la tabla audit_logs existente (legacy, schema pobre). Ambas conviven.
--
-- Idempotente: usa IF NOT EXISTS en todo. Seguro de ejecutar varias veces.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT,                                       -- multi-tenant futuro
  ticket_id       TEXT,                                       -- ticket.key cuando aplique
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name      TEXT,
  actor_role      TEXT,                                       -- legacy role: viewer|consultor|aprobador|admin
  event_type      TEXT NOT NULL,                              -- TICKET_CREATED, ROLE_PERMISSIONS_UPDATED, etc.
  category        TEXT NOT NULL DEFAULT 'general',            -- ticket | rbac | estimation | customer_response | quality | intelligence | security | general
  severity        TEXT NOT NULL DEFAULT 'info',               -- info | warning | error | critical
  payload         JSONB,                                       -- detalle del evento
  source          TEXT NOT NULL DEFAULT 'ui',                 -- ui | agent | system | integration | api
  correlation_id  TEXT,                                       -- para correlacionar eventos de una misma transacción
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para queries comunes
CREATE INDEX IF NOT EXISTS idx_audit_events_ticket      ON audit_events(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_type        ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_category    ON audit_events(category);
CREATE INDEX IF NOT EXISTS idx_audit_events_severity    ON audit_events(severity);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor       ON audit_events(actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at  ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation ON audit_events(correlation_id) WHERE correlation_id IS NOT NULL;

-- Comentarios para documentación
COMMENT ON TABLE  audit_events IS 'Audit Trail rico (DH v0.9). Reemplaza progresivamente a audit_logs.';
COMMENT ON COLUMN audit_events.tenant_id IS 'Para multi-tenant futuro. Hoy NULL.';
COMMENT ON COLUMN audit_events.ticket_id IS 'ticket.key (no UUID) cuando el evento es de ticket.';
COMMENT ON COLUMN audit_events.event_type IS 'Ver lista en src/types/audit-events.types.ts → AuditEventType.';
COMMENT ON COLUMN audit_events.category IS 'Agrupador para filtros UI.';
COMMENT ON COLUMN audit_events.correlation_id IS 'Para hilar eventos relacionados (ej. clasificar+respuesta+escalar).';
