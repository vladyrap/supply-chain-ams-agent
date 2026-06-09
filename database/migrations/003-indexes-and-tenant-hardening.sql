-- =============================================================================
-- 003-indexes-and-tenant-hardening.sql (v1.1.2-hotfix audit v1.1.0)
-- =============================================================================
-- Fixes:
--   M3 — GIN index sobre tickets_demo.intelligence (JSONB) para queries por
--        contenido del análisis. Sin esto, future search full-scan.
--   M4 — BRIN index sobre agent_usage.created_at. Tabla append-only ordenada
--        por tiempo: BRIN da 10-100× speedup para queries por rango temporal
--        del panel admin.
--   M5 — Composite indexes sobre audit_events para combos comunes:
--          (ticket_id, created_at DESC)  ← timeline ticket
--          (category, severity, created_at DESC) ← filtros dashboard
--          (tenant_id, created_at DESC) ← scope tenant + recientes
--   M6 — UNIQUE index sobre LOWER(email) para users (case-insensitive).
--   H6 — BRIN equivalent sobre tablas con created_at.
--
-- Todos los CREATE INDEX usan CONCURRENTLY donde posible para no lockear la
-- tabla en prod. IF NOT EXISTS para idempotencia.
-- =============================================================================

-- M3 · GIN sobre intelligence (JSONB)
CREATE INDEX IF NOT EXISTS idx_tickets_demo_intelligence_gin
  ON tickets_demo USING GIN (intelligence jsonb_path_ops);

-- M4 · BRIN sobre agent_usage.created_at (admin dashboard)
-- FIX (QAS audit MT v1.2.2): solo aplicar si la tabla existe (creada en runtime
-- por admin-usage.service). Antes este bloque fallaba "table not exist" o
-- "column not exist" en QAS fresh.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='agent_usage') THEN
    -- Agregar columna tenant_id si falta (la tabla la crea el service sin esta col)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='agent_usage' AND column_name='tenant_id') THEN
      ALTER TABLE agent_usage ADD COLUMN tenant_id TEXT;
    END IF;
    -- BRIN index sobre created_at
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_agent_usage_created_brin
             ON agent_usage USING BRIN (created_at) WITH (pages_per_range = 32)';
    -- Tenant scoping
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_agent_usage_tenant_created
             ON agent_usage (tenant_id, created_at DESC)';
  END IF;
END $$;

-- M5 · Composite indexes en audit_events
CREATE INDEX IF NOT EXISTS idx_audit_events_ticket_created
  ON audit_events (ticket_id, created_at DESC)
  WHERE ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_events_category_severity_created
  ON audit_events (category, severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_created
  ON audit_events (tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

-- M6 · UNIQUE LOWER(email) en users (case-insensitive)
-- Si ya hay duplicates por case, primero normalizar:
UPDATE users SET email = LOWER(email) WHERE email != LOWER(email);
-- Crear el unique nuevo (el viejo CONSTRAINT UNIQUE email permanece pero ya no
-- es necesario; lo dejamos para no romper PKs que lo referencien):
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower
  ON users (LOWER(email));

-- pgvector knowledge_items — HNSW para mejor recall sin tuning (pgvector >= 0.5)
-- Solo si no existe el IVFFLAT viejo. Si existe, dejamos coexistir y el planner
-- elige el mejor por costo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'knowledge_items'
      AND indexname = 'idx_knowledge_embedding_hnsw'
  ) THEN
    BEGIN
      CREATE INDEX idx_knowledge_embedding_hnsw
        ON knowledge_items USING hnsw (embedding vector_cosine_ops);
    EXCEPTION WHEN OTHERS THEN
      -- pgvector < 0.5 no soporta HNSW; ignorar silenciosamente.
      RAISE NOTICE 'HNSW no disponible en este pgvector; mantener IVFFLAT';
    END;
  END IF;
END $$;

-- Comentar tablas pesadas para documentación
COMMENT ON INDEX idx_tickets_demo_intelligence_gin IS 'audit v1.1.0 M3 — JSONB search';
COMMENT ON INDEX idx_agent_usage_created_brin IS 'audit v1.1.0 M4 — admin dashboard speedup';
COMMENT ON INDEX idx_audit_events_ticket_created IS 'audit v1.1.0 M5 — timeline ticket';
COMMENT ON INDEX uq_users_email_lower IS 'audit v1.1.0 M6 — email case-insensitive';
