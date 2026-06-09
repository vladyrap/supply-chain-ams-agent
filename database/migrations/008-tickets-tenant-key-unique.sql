-- =============================================================================
-- 008-tickets-tenant-key-unique.sql (v1.2.3-qas)
-- =============================================================================
-- Fix detectado en QAS local v1.2.2:
--   El backend hace `INSERT INTO tickets_demo ... ON CONFLICT (tenant_id, key)
--   DO NOTHING` (seedMockTicketsIfMissing) y también en otros puntos, pero la
--   tabla solo tiene PK simple sobre (key). PostgreSQL rechaza el ON CONFLICT
--   con "no unique or exclusion constraint matching the ON CONFLICT
--   specification" → seed inicial nunca corre, mock tickets no se generan en
--   tenants nuevos, intelligence updates fallan silenciosamente.
--
-- Fix: agregar UNIQUE INDEX composite (tenant_id, key). Idempotente.
-- =============================================================================

-- 1. UNIQUE composite — habilita el ON CONFLICT (tenant_id, key)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_demo_tenant_key
  ON tickets_demo (tenant_id, key);

-- 2. Comentario para documentación
COMMENT ON INDEX uq_tickets_demo_tenant_key IS
  'QAS v1.2.3 — habilita ON CONFLICT (tenant_id, key) en seed mock + intelligence upsert';

-- 3. Verificar que no hay duplicados pre-existentes (debería ser 0)
DO $$
DECLARE
  v_dups INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_dups
  FROM (
    SELECT tenant_id, key, COUNT(*) AS c
    FROM tickets_demo
    GROUP BY tenant_id, key
    HAVING COUNT(*) > 1
  ) t;
  IF v_dups > 0 THEN
    RAISE WARNING 'tickets_demo: % duplicados (tenant_id, key) detectados', v_dups;
  END IF;
END $$;
