-- =============================================================================
-- 004-fk-hardening-and-uuid.sql · audit v1.1.0 cierre de medios+bajos
-- =============================================================================
-- Fixes:
--   M1   — DDL de audit_events.service.ts extraído acá (no más DDL en runtime)
--   M7   — FK actor_user_id ON DELETE NO ACTION (audit no pierde actor al borrar user)
--   B3   — Index sessions (user_id, expires_at) para purge eficiente
--   B5   — FK call_turns(call_sid) → call_logs(call_sid)
--
-- Idempotente: IF NOT EXISTS / DO blocks defensivos.
-- =============================================================================

-- ===== M1: schema de audit_events centralizado (idempotente) =====
CREATE TABLE IF NOT EXISTS audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT,
  ticket_id       TEXT,
  actor_user_id   UUID REFERENCES users(id) ON DELETE NO ACTION,
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

CREATE INDEX IF NOT EXISTS idx_audit_events_ticket
  ON audit_events(ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_type ON audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_events_category ON audit_events(category);
CREATE INDEX IF NOT EXISTS idx_audit_events_severity ON audit_events(severity);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor
  ON audit_events(actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation
  ON audit_events(correlation_id) WHERE correlation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION audit_events_minute_bucket(ts TIMESTAMPTZ)
RETURNS BIGINT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT EXTRACT(EPOCH FROM ts)::bigint / 60;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_events_dedup_minute
  ON audit_events (event_type, ticket_id, audit_events_minute_bucket(created_at))
  WHERE ticket_id IS NOT NULL;

-- ===== M7: cambiar FK actor_user_id de SET NULL a NO ACTION =====
-- Si ya existe el constraint con ON DELETE SET NULL, lo redefinimos.
DO $$
DECLARE
  conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO conname
  FROM information_schema.table_constraints tc
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_name = 'audit_events'
    AND EXISTS (
      SELECT 1 FROM information_schema.constraint_column_usage cc
      WHERE cc.constraint_name = tc.constraint_name
        AND cc.column_name = 'id'
        AND cc.table_name = 'users'
    )
  LIMIT 1;
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS %I', conname);
  END IF;
END $$;

ALTER TABLE audit_events
  ADD CONSTRAINT fk_audit_events_actor_user
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE NO ACTION;

-- ===== B3: index para purge de sessions vencidas =====
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'sessions'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'expires_at'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_sessions_user_expires
             ON sessions(user_id, expires_at)';
  END IF;
END $$;

-- ===== B5: FK call_turns(call_sid) → call_logs(call_sid) =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'call_turns')
     AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'call_logs')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
       WHERE table_name = 'call_turns' AND constraint_name = 'fk_call_turns_call_sid'
     )
  THEN
    -- Limpiar orphans antes de crear el FK
    DELETE FROM call_turns WHERE call_sid NOT IN (SELECT call_sid FROM call_logs);
    EXECUTE 'ALTER TABLE call_turns
             ADD CONSTRAINT fk_call_turns_call_sid
             FOREIGN KEY (call_sid) REFERENCES call_logs(call_sid) ON DELETE CASCADE';
  END IF;
END $$;

COMMENT ON CONSTRAINT fk_audit_events_actor_user ON audit_events
  IS 'audit v1.1.0 M7 — NO ACTION para preservar forensics al soft-delete users';
