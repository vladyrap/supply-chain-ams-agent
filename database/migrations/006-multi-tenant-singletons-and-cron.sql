-- =============================================================================
-- 006-multi-tenant-singletons-and-cron.sql · MT Sprint 6 cierres (v1.2.0)
-- =============================================================================
-- Cierra dos cabos que los sprints anteriores dejaron en runtime ensureSchema:
--   1. PK compuesto (tenant_id, id) en tablas SINGLETON (escalation_settings,
--      testing_settings, itsm_connectors). Sprint 3 cambió esto en runtime,
--      ahora lo formaliza como migration versionada para prod.
--   2. tenant_id en kb_self_training_runs (Sprint 3 lo agregó en runtime via
--      ALTER TABLE IF EXISTS — formalizar acá).
--   3. tenant_id en agent_prompt_versions + UNIQUE (tenant_id, active) (Sprint 3).
--   4. tenant_id en agent_hallucinations + index (Sprint 3).
--
-- Idempotente.
-- =============================================================================

-- ===== 1. Singletons → PK compuesto (tenant_id, id) =====

-- escalation_settings
DO $$
DECLARE
  pkname TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='escalation_settings') THEN
    -- Drop OLD pk si era PRIMARY KEY (id) CHECK(id=1)
    SELECT constraint_name INTO pkname
      FROM information_schema.table_constraints
     WHERE table_name='escalation_settings' AND constraint_type='PRIMARY KEY' LIMIT 1;
    IF pkname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE escalation_settings DROP CONSTRAINT %I', pkname);
    END IF;
    -- Drop CHECK(id=1) si existe
    EXECUTE 'ALTER TABLE escalation_settings DROP CONSTRAINT IF EXISTS escalation_settings_id_check';
    -- Crear UNIQUE (tenant_id, id) si no existe — usado como upsert key
    CREATE UNIQUE INDEX IF NOT EXISTS uq_escalation_settings_tenant_id
      ON escalation_settings (tenant_id, id);
  END IF;
END $$;

-- testing_settings
DO $$
DECLARE
  pkname TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='testing_settings') THEN
    SELECT constraint_name INTO pkname
      FROM information_schema.table_constraints
     WHERE table_name='testing_settings' AND constraint_type='PRIMARY KEY' LIMIT 1;
    IF pkname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE testing_settings DROP CONSTRAINT %I', pkname);
    END IF;
    EXECUTE 'ALTER TABLE testing_settings DROP CONSTRAINT IF EXISTS testing_settings_id_check';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_testing_settings_tenant_id
      ON testing_settings (tenant_id, id);
  END IF;
END $$;

-- itsm_connectors
DO $$
DECLARE
  pkname TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='itsm_connectors') THEN
    SELECT constraint_name INTO pkname
      FROM information_schema.table_constraints
     WHERE table_name='itsm_connectors' AND constraint_type='PRIMARY KEY' LIMIT 1;
    IF pkname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE itsm_connectors DROP CONSTRAINT %I', pkname);
    END IF;
    EXECUTE 'ALTER TABLE itsm_connectors DROP CONSTRAINT IF EXISTS itsm_connectors_id_check';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_itsm_connectors_tenant_id
      ON itsm_connectors (tenant_id, id);
  END IF;
END $$;

-- ===== 2. kb_self_training_runs.tenant_id (NOT NULL + FK + index) =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='kb_self_training_runs') THEN
    -- ADD COLUMN si falta (idempotente)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='kb_self_training_runs' AND column_name='tenant_id') THEN
      ALTER TABLE kb_self_training_runs ADD COLUMN tenant_id TEXT;
    END IF;
    UPDATE kb_self_training_runs SET tenant_id='default' WHERE tenant_id IS NULL;
    ALTER TABLE kb_self_training_runs ALTER COLUMN tenant_id SET NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                   WHERE table_name='kb_self_training_runs' AND constraint_name='fk_kb_self_training_runs_tenant') THEN
      ALTER TABLE kb_self_training_runs
        ADD CONSTRAINT fk_kb_self_training_runs_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
    END IF;
    CREATE INDEX IF NOT EXISTS idx_kb_self_training_runs_tenant_started
      ON kb_self_training_runs (tenant_id, started_at DESC);
  END IF;
END $$;

-- ===== 3. agent_prompt_versions: tenant_id + UNIQUE active per tenant =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='agent_prompt_versions') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='agent_prompt_versions' AND column_name='tenant_id') THEN
      ALTER TABLE agent_prompt_versions ADD COLUMN tenant_id TEXT;
    END IF;
    UPDATE agent_prompt_versions SET tenant_id='default' WHERE tenant_id IS NULL;
    ALTER TABLE agent_prompt_versions ALTER COLUMN tenant_id SET NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                   WHERE table_name='agent_prompt_versions' AND constraint_name='fk_agent_prompt_versions_tenant') THEN
      ALTER TABLE agent_prompt_versions
        ADD CONSTRAINT fk_agent_prompt_versions_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
    END IF;
    -- Solo UN prompt activo POR TENANT
    DROP INDEX IF EXISTS uq_agent_prompt_versions_active;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_prompt_versions_tenant_active
      ON agent_prompt_versions (tenant_id) WHERE active = true;
  END IF;
END $$;

-- ===== 4. agent_hallucinations.tenant_id + index =====
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='agent_hallucinations') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='agent_hallucinations' AND column_name='tenant_id') THEN
      ALTER TABLE agent_hallucinations ADD COLUMN tenant_id TEXT;
    END IF;
    UPDATE agent_hallucinations SET tenant_id='default' WHERE tenant_id IS NULL;
    ALTER TABLE agent_hallucinations ALTER COLUMN tenant_id SET NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                   WHERE table_name='agent_hallucinations' AND constraint_name='fk_agent_hallucinations_tenant') THEN
      ALTER TABLE agent_hallucinations
        ADD CONSTRAINT fk_agent_hallucinations_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
    END IF;
    CREATE INDEX IF NOT EXISTS idx_agent_hallucinations_tenant
      ON agent_hallucinations (tenant_id);
  END IF;
END $$;

-- =============================================================================
-- Verificación rápida — listar columnas tenant_id presentes
-- (correr manualmente para confirmar):
--   SELECT table_name FROM information_schema.columns
--    WHERE column_name='tenant_id' ORDER BY table_name;
-- =============================================================================
