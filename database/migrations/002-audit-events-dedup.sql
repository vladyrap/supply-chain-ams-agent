-- =============================================================================
-- 002-audit-events-dedup.sql — UNIQUE constraint anti-duplicación (v0.12.1)
-- =============================================================================
-- Previene la duplicación masiva de audit_events observada el 2026-06-05
-- (16,033 filas duplicadas por bug del frontend pre-v0.14.8).
--
-- Estrategia: UNIQUE INDEX parcial sobre (event_type, ticket_id, minuto-epoch)
-- usando una función IMMUTABLE wrapper sobre EXTRACT(EPOCH) — necesario porque
-- date_trunc() con TIMESTAMPTZ NO es immutable (depende del timezone de sesión).
--
-- EXTRACT(EPOCH FROM tz) SÍ es immutable porque devuelve segundos UTC absolutos.
-- Dividir por 60 da el "número de minuto" desde epoch — único por minuto.
--
-- Eventos sin ticket_id (system-wide, RBAC, multi-actor) NO se deduplican
-- porque pueden legítimamente repetirse en un mismo minuto.
--
-- Idempotente: CREATE OR REPLACE + IF NOT EXISTS en todo.
-- =============================================================================

-- Función IMMUTABLE wrapper para indexar por minuto sin depender de timezone.
CREATE OR REPLACE FUNCTION audit_events_minute_bucket(ts TIMESTAMPTZ)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT EXTRACT(EPOCH FROM ts)::bigint / 60;
$$;

COMMENT ON FUNCTION audit_events_minute_bucket(TIMESTAMPTZ) IS
  'Bucket por minuto desde epoch UTC. Immutable, indexable. Usada por uq_audit_events_dedup_minute.';

-- UNIQUE INDEX parcial: 1 evento por (event_type + ticket_id + minuto).
-- WHERE ticket_id IS NOT NULL → eventos sin ticket quedan libres.
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_events_dedup_minute
  ON audit_events (event_type, ticket_id, audit_events_minute_bucket(created_at))
  WHERE ticket_id IS NOT NULL;

COMMENT ON INDEX uq_audit_events_dedup_minute IS
  'Anti-duplicación: máx 1 evento por (event_type, ticket_id, minuto) cuando hay ticket. Previene el bug del 2026-06-05.';
