-- =============================================================================
-- 009-password-reset-tokens.sql (v1.2.5-prod feature)
-- =============================================================================
-- Tabla para tokens de reset de password (flow "olvidé mi contraseña").
-- Single-use, expiran a las 2h, tenant-scoped, auditables.
-- =============================================================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           TEXT PRIMARY KEY,                       -- token opaco (random hex)
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,                          -- snapshot del email solicitado
  expires_at   TIMESTAMPTZ NOT NULL,                   -- typically now() + 2h
  used_at      TIMESTAMPTZ,                            -- NULL = unused
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_pwreset_tenant ON password_reset_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pwreset_expires ON password_reset_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_pwreset_unused ON password_reset_tokens(user_id) WHERE used_at IS NULL;

COMMENT ON TABLE password_reset_tokens IS 'v1.2.5: tokens single-use para flow "olvidé contraseña". Auto-expire 2h.';
