-- =============================================================================
-- 005-multi-tenant-foundation.sql · Multi-tenant foundation v1.2.0
-- =============================================================================
-- Objetivo: convertir AMS Platform de single-tenant a multi-tenant real.
--
-- Strategy:
--   1. CREATE TABLE tenants (catálogo)
--   2. Seed 'default' tenant
--   3. Para CADA tabla con datos del cliente:
--      a. ALTER ADD COLUMN tenant_id TEXT (nullable inicialmente)
--      b. UPDATE backfill SET tenant_id='default' WHERE tenant_id IS NULL
--      c. ALTER ALTER COLUMN tenant_id SET NOT NULL
--      d. ADD CONSTRAINT FK tenant_id → tenants(id) ON DELETE RESTRICT
--      e. CREATE INDEX (tenant_id) o composite con created_at
--
-- Idempotente: IF NOT EXISTS + DO blocks defensivos.
-- Tablas globales NO tocadas: schema_migrations, sap_scope_items (catalog SAP),
-- platform_roles (catálogo de roles del producto).
--
-- Tablas creadas en runtime por services (CREATE TABLE IF NOT EXISTS en cada
-- service) — el ALTER acá las cubre cuando ya existen. Si la tabla aún no
-- fue creada por su service, el bloque se skippea defensivamente.
-- =============================================================================

-- =====================================================================
-- 1. TABLA tenants (catálogo)
-- =====================================================================
CREATE TABLE IF NOT EXISTS tenants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  subdomain       TEXT UNIQUE,
  plan            TEXT NOT NULL DEFAULT 'standard',  -- starter|standard|premium|enterprise
  status          TEXT NOT NULL DEFAULT 'active',     -- active|trial|suspended|deleted
  brand           JSONB NOT NULL DEFAULT '{}'::jsonb, -- {logo, accent, name}
  settings        JSONB NOT NULL DEFAULT '{}'::jsonb, -- {timezone, locale, currency, ...}
  monthly_quota_tickets  INTEGER,                    -- NULL = ilimitado
  monthly_quota_gemini_usd NUMERIC(10,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  trial_ends_at   TIMESTAMPTZ,
  CONSTRAINT tenants_status_chk CHECK (status IN ('active','trial','suspended','deleted')),
  CONSTRAINT tenants_plan_chk CHECK (plan IN ('starter','standard','premium','enterprise'))
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain) WHERE subdomain IS NOT NULL;

-- Seed tenant 'default' para datos existentes pre-multi-tenant
INSERT INTO tenants (id, name, subdomain, plan, status, brand)
VALUES (
  'default',
  'Default Tenant',
  NULL,
  'standard',
  'active',
  '{"name":"AMS Platform","accent":"#22d3ee"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE tenants IS 'Catálogo de tenants (clientes). v1.2.0 multi-tenant foundation.';

-- =====================================================================
-- 2. Helper function — añadir tenant_id a una tabla idempotentemente
-- =====================================================================
-- Uso interno: añade columna, backfill, NOT NULL, FK, index.
CREATE OR REPLACE FUNCTION mt_add_tenant_id(p_table TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  -- Skip si la tabla no existe (creada en runtime por service que aún no corrió)
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = p_table AND table_schema = current_schema()) THEN
    RAISE NOTICE 'mt_add_tenant_id: tabla % no existe — skipped (creada en runtime?)', p_table;
    RETURN;
  END IF;

  -- ADD COLUMN si falta
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = p_table AND column_name = 'tenant_id' AND table_schema = current_schema()
  ) THEN
    EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id TEXT', p_table);
    RAISE NOTICE 'mt_add_tenant_id: ALTER ADD tenant_id en %', p_table;
  END IF;

  -- BACKFILL nulls a 'default'
  EXECUTE format('UPDATE %I SET tenant_id = ''default'' WHERE tenant_id IS NULL', p_table);

  -- SET NOT NULL (idempotente si ya está)
  EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', p_table);

  -- FK a tenants(id) — ON DELETE RESTRICT para evitar borrar tenant con data
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = p_table AND constraint_name = 'fk_' || p_table || '_tenant'
  ) THEN
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT fk_%s_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT',
      p_table, p_table
    );
  END IF;

  -- Index para queries scoped (idempotente)
  EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_tenant ON %I(tenant_id)', p_table, p_table);
END $$;

-- =====================================================================
-- 3. Aplicar a TODAS las tablas con datos de cliente
-- =====================================================================

-- ----- Tablas en init.sql -----
SELECT mt_add_tenant_id('users');
SELECT mt_add_tenant_id('sessions');
SELECT mt_add_tenant_id('incidents');
SELECT mt_add_tenant_id('audit_logs');                  -- legacy, coexiste con audit_events
SELECT mt_add_tenant_id('agent_feedback');
SELECT mt_add_tenant_id('knowledge_documents');
SELECT mt_add_tenant_id('knowledge_items');
SELECT mt_add_tenant_id('meetings');
SELECT mt_add_tenant_id('call_logs');
SELECT mt_add_tenant_id('call_turns');

-- ----- audit_events: columna ya existe, sólo backfill + NOT NULL -----
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_events') THEN
    UPDATE audit_events SET tenant_id = 'default' WHERE tenant_id IS NULL;
    ALTER TABLE audit_events ALTER COLUMN tenant_id SET NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'audit_events' AND constraint_name = 'fk_audit_events_tenant'
    ) THEN
      ALTER TABLE audit_events ADD CONSTRAINT fk_audit_events_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
    END IF;
  END IF;
END $$;

-- ----- Tablas creadas en runtime por services (best-effort, skip si no existen) -----

-- Auth / Identity
SELECT mt_add_tenant_id('refresh_tokens');
SELECT mt_add_tenant_id('auth_events');
SELECT mt_add_tenant_id('platform_users');  -- platform_roles es global (catálogo)

-- Tickets
SELECT mt_add_tenant_id('tickets_demo');
SELECT mt_add_tenant_id('ticket_intelligence_history');

-- Support
SELECT mt_add_tenant_id('support_tickets');
SELECT mt_add_tenant_id('support_messages');
SELECT mt_add_tenant_id('support_conversations');
SELECT mt_add_tenant_id('support_audit');
SELECT mt_add_tenant_id('kb_articles');

-- Knowledge / RAG
SELECT mt_add_tenant_id('agent_knowledge');
SELECT mt_add_tenant_id('agent_qa');
SELECT mt_add_tenant_id('search_index');

-- Training
SELECT mt_add_tenant_id('kb_training_items');
SELECT mt_add_tenant_id('kb_training_qa');
SELECT mt_add_tenant_id('kb_training_versions');
SELECT mt_add_tenant_id('kb_training_gaps');
SELECT mt_add_tenant_id('kb_training_settings');
SELECT mt_add_tenant_id('kb_training_qa_embeddings');
SELECT mt_add_tenant_id('kb_training_item_embeddings');
SELECT mt_add_tenant_id('kb_self_training_config');
SELECT mt_add_tenant_id('kb_self_training_runs');

-- AI Pipeline
SELECT mt_add_tenant_id('agent_prompt_versions');
SELECT mt_add_tenant_id('customer_responses');
SELECT mt_add_tenant_id('generated_documents');
SELECT mt_add_tenant_id('ai_response_feedback');
SELECT mt_add_tenant_id('agent_response_provenance');
SELECT mt_add_tenant_id('agent_hallucinations');
SELECT mt_add_tenant_id('agent_evaluations');

-- Escalation
SELECT mt_add_tenant_id('escalation_rules');
SELECT mt_add_tenant_id('escalation_records');
SELECT mt_add_tenant_id('n2_responsibles');
SELECT mt_add_tenant_id('itsm_connectors');
SELECT mt_add_tenant_id('escalation_settings');

-- Playbooks
SELECT mt_add_tenant_id('playbooks');
SELECT mt_add_tenant_id('playbook_executions');

-- Testing Intelligence
SELECT mt_add_tenant_id('testing_scenarios');
SELECT mt_add_tenant_id('testing_evidences');
SELECT mt_add_tenant_id('testing_defects');
SELECT mt_add_tenant_id('testing_manuals');
SELECT mt_add_tenant_id('testing_settings');

-- Eval
SELECT mt_add_tenant_id('eval_runs');
SELECT mt_add_tenant_id('eval_results');
SELECT mt_add_tenant_id('qa_eval_runs');
SELECT mt_add_tenant_id('qa_eval_results');

-- SAP Inbound
SELECT mt_add_tenant_id('sap_inbound_tokens');
SELECT mt_add_tenant_id('sap_inbound_events');

-- Integrations (destinations + deliveries)
SELECT mt_add_tenant_id('integration_destinations');
SELECT mt_add_tenant_id('integration_deliveries');

-- Telemetría (agent_usage ya tiene tenant_id por mig 003, pero faltaba NOT NULL)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_usage') THEN
    UPDATE agent_usage SET tenant_id = 'default' WHERE tenant_id IS NULL;
    ALTER TABLE agent_usage ALTER COLUMN tenant_id SET NOT NULL;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'agent_usage' AND constraint_name = 'fk_agent_usage_tenant'
    ) THEN
      ALTER TABLE agent_usage ADD CONSTRAINT fk_agent_usage_tenant
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;
    END IF;
  END IF;
END $$;

-- =====================================================================
-- 4. UNIQUE constraints scoped por tenant
-- =====================================================================
-- users.email DEBE ser único POR TENANT (no global).
-- Antes era global; ahora dropear y recrear scoped.
DO $$
BEGIN
  -- Drop UNIQUE viejo en email (case-sensitive)
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'users' AND constraint_name = 'users_email_key'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_email_key;
  END IF;
  -- Drop UNIQUE index viejo case-insensitive (mig 003)
  DROP INDEX IF EXISTS uq_users_email_lower;
  -- Crear UNIQUE scoped por tenant + case-insensitive
  CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_email_lower
    ON users (tenant_id, LOWER(email));
END $$;

-- Análogos en otras tablas que tenían UNIQUE global:
-- tickets_demo.key debe ser único POR TENANT (era único global)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tickets_demo') THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'tickets_demo' AND constraint_name LIKE 'tickets_demo_key%'
    ) THEN
      -- Drop el unique de key
      ALTER TABLE tickets_demo DROP CONSTRAINT IF EXISTS tickets_demo_pkey CASCADE;
      ALTER TABLE tickets_demo ADD PRIMARY KEY (tenant_id, key);
    END IF;
  END IF;
END $$;

-- =====================================================================
-- 5. Composite indexes para perf de queries scoped + temporales
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_created_v2
  ON audit_events(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_usage_tenant_created_v2
  ON agent_usage(tenant_id, created_at DESC);

-- =====================================================================
-- 6. Cleanup helper function
-- =====================================================================
DROP FUNCTION IF EXISTS mt_add_tenant_id(TEXT);

-- =====================================================================
-- 7. Comments para documentación
-- =====================================================================
COMMENT ON COLUMN tenants.brand IS 'JSONB: {logo: URL, accent: hex color, name: display name}';
COMMENT ON COLUMN tenants.settings IS 'JSONB: {timezone, locale, currency, sla, ...}';
COMMENT ON COLUMN tenants.monthly_quota_tickets IS 'NULL = ilimitado. Si quota se alcanza, nuevos tickets devuelven 429';
COMMENT ON COLUMN tenants.monthly_quota_gemini_usd IS 'Tope mensual de gasto Gemini. NULL = ilimitado.';
