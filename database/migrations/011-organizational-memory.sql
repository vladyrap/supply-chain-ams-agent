-- =============================================================================
-- 011 — Organizational Memory (ROCCO — Fase 1 del activo #1)
-- =============================================================================
-- Subsistema de Memoria Organizacional de primera clase (Constitución Art. 8).
-- Un MemoryRecord es una unidad de memoria (incidente resuelto, decisión,
-- assessment, cambio de config, aprendizaje, doc). Cada uno con provenance y,
-- si su confianza es "evidence", con >=1 EvidenceUnit (Evidence by Design, Art. 4).
--
-- Principios aplicados: multi-tenant, provenance obligatoria, content_hash
-- reproducible, ingesta idempotente (dedupe_key), versionado append-friendly.
-- Aditivo: no altera tablas existentes. El runtime también auto-provisiona vía
-- ensureMemorySchema() al arranque.
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_record (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- incident_resolution|decision|assessment|config_change|learning|doc
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  confidence    TEXT NOT NULL DEFAULT 'inferred',  -- evidence|inferred|unverified
  provenance    JSONB NOT NULL DEFAULT '{}'::jsonb, -- {origin, source, at, ...}
  node_refs     JSONB NOT NULL DEFAULT '[]'::jsonb, -- ids de kg_node relacionados
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes    UUID,
  dedupe_key    TEXT,                   -- ingesta idempotente por entidad origen
  content_hash  TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT 'system',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_mem_kind CHECK (kind IN ('incident_resolution','decision','assessment','config_change','learning','doc')),
  CONSTRAINT chk_mem_conf CHECK (confidence IN ('evidence','inferred','unverified'))
);
CREATE INDEX IF NOT EXISTS idx_mem_tenant_kind   ON memory_record (tenant_id, kind);
CREATE INDEX IF NOT EXISTS idx_mem_tenant_updated ON memory_record (tenant_id, updated_at DESC);
-- Unicidad de la clave de dedupe por tenant (parcial: permite records manuales sin clave).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mem_dedupe ON memory_record (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_evidence (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL,
  record_id    UUID NOT NULL REFERENCES memory_record(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,          -- sap_connector|sap_readonly|ticket|kb|meeting|document|human|ai
  ref          TEXT NOT NULL,          -- id/url del respaldo
  hash         TEXT,                   -- hash del respaldo (reproducibilidad)
  captured_by  TEXT NOT NULL DEFAULT 'system',
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mem_ev_record ON memory_evidence (tenant_id, record_id);
