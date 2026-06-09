-- =============================================================================
-- 007-mt-audit-fixes.sql · Cierre de gaps audit MT v1.2.0
-- =============================================================================
-- Fixes:
--   G7: escalation_records.escalation_number era UNIQUE GLOBAL → 2 tenants
--       generando "ESC-0001" colisionan. Cambiar a UNIQUE (tenant_id, escalation_number).
--   G6 SQL: defensa-en-profundidad para dashboard.service.ts JOIN users
--       (no toca DB, solo nota).
--
-- Idempotente.
-- =============================================================================

-- ===== G7: escalation_records.escalation_number UNIQUE per-tenant =====
DO $$
DECLARE
  uname TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='escalation_records') THEN
    -- Detectar y dropear constraint UNIQUE global existente sobre escalation_number
    FOR uname IN
      SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage cu
          ON cu.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'escalation_records'
         AND tc.constraint_type = 'UNIQUE'
         AND cu.column_name = 'escalation_number'
    LOOP
      EXECUTE format('ALTER TABLE escalation_records DROP CONSTRAINT %I', uname);
      RAISE NOTICE 'Dropped UNIQUE constraint % on escalation_records', uname;
    END LOOP;

    -- Idem para UNIQUE INDEX (no constraint)
    EXECUTE 'DROP INDEX IF EXISTS escalation_records_escalation_number_key';

    -- Crear UNIQUE compuesto (tenant_id, escalation_number)
    CREATE UNIQUE INDEX IF NOT EXISTS uq_escalation_records_tenant_number
      ON escalation_records (tenant_id, escalation_number);
  END IF;
END $$;

-- ===== Comentario informativo para futuros mantenedores =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='escalation_records') THEN
    COMMENT ON INDEX uq_escalation_records_tenant_number IS
      'audit MT v1.2.0 G7 — escalation_number unique per-tenant (no global)';
  END IF;
END $$;
