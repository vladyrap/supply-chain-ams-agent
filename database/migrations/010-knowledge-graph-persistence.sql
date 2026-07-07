-- =============================================================================
-- 010 — Knowledge Graph Persistence (ROCCO — Fase 0 del activo #1)
-- =============================================================================
-- Materializa el grafo de conocimiento (hoy proyectado en tiempo de lectura por
-- graph.service.getKnowledgeGraph) a tablas persistidas kg_node / kg_edge.
--
-- Principios de la Constitución aplicados:
--   * Multi-tenant: tenant_id en cada fila; PK compuesta (tenant_id, id).
--   * Evidence by Design: cada nodo/arista lleva content_hash reproducible +
--     provenance (origen/fuente/computed_at). Nada sin origen trazable.
--   * Idempotente: CREATE ... IF NOT EXISTS; el rebuild hace UPSERT + reconcilia
--     stale, de modo que recomputar no duplica.
--   * Aditivo y backward-compatible: NO altera ninguna tabla existente. El
--     endpoint /api/graph sigue sirviendo la proyección en vivo.
--
-- Nota: el runtime también auto-provisiona estas tablas vía
-- ensureKnowledgeGraphSchema() al arranque (patrón ensureVoiceSchema del repo).
-- Esta migración es el registro formal/versionado del esquema.
-- =============================================================================

CREATE TABLE IF NOT EXISTS kg_node (
  tenant_id      TEXT NOT NULL,
  id             TEXT NOT NULL,           -- id de la entidad origen (estable)
  type           TEXT NOT NULL,           -- incident|ticket|conversation|kb|meeting (+ futuros)
  label          TEXT NOT NULL,
  subtitle       TEXT,
  href           TEXT,
  meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {origin, source, computed_at}
  content_hash   TEXT NOT NULL,            -- sha256 canónico (reproducibilidad)
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_kg_node_tenant_type ON kg_node (tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_kg_node_last_seen  ON kg_node (tenant_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS kg_edge (
  tenant_id      TEXT NOT NULL,
  id             TEXT NOT NULL,           -- sha256 determinista(from|kind|to)
  from_id        TEXT NOT NULL,
  to_id          TEXT NOT NULL,
  kind           TEXT NOT NULL,           -- escalated|uses_kb|kb_from|linked (+ futuros)
  provenance     JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash   TEXT NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_kg_edge_tenant ON kg_edge (tenant_id);
CREATE INDEX IF NOT EXISTS idx_kg_edge_from   ON kg_edge (tenant_id, from_id);
CREATE INDEX IF NOT EXISTS idx_kg_edge_to     ON kg_edge (tenant_id, to_id);
