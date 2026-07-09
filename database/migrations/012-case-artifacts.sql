-- =============================================================================
-- 012-case-artifacts.sql — Artefactos de 1ª clase del caso (Case Timeline F4)
-- =============================================================================
-- Adjuntos, SAP Notes, código ABAP, dumps ST22, logs, capturas y correos como
-- entidades reales asociadas a un ticket. Multi-tenant, con hash de integridad.
-- Idempotente. Espejo formal del ensure...Schema() en case-artifacts.service.ts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS case_artifacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'default',
  ticket_key    TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- sap_note | abap | attachment | evidence | log | dump | screenshot | email
  title         TEXT NOT NULL,
  ref           TEXT,            -- URL / número de SAP Note / path lógico
  content       TEXT,            -- texto (redactado) opcional
  content_hash  TEXT,            -- SHA-256 del content (integridad)
  meta          JSONB,
  created_by    TEXT NOT NULL DEFAULT 'system',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_artifacts_ticket
  ON case_artifacts (tenant_id, ticket_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_case_artifacts_kind
  ON case_artifacts (tenant_id, kind);
