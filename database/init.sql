-- =====================================================
-- supply-chain-ams-agent — esquema inicial
-- Se ejecuta UNA sola vez al crear el contenedor db.
-- =====================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- -----------------------------------------------------
-- users + sessions: autenticacion local (Fase 6)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT,
    role          TEXT NOT NULL DEFAULT 'consultor',
                          -- viewer | consultor | aprobador | admin
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_role  ON users (role);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,           -- token aleatorio
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- -----------------------------------------------------
-- incidents: cada interaccion del usuario con el agente
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_name    TEXT,
    client_name  TEXT,
    sap_module   TEXT,
    environment  TEXT,
    message      TEXT NOT NULL,
    response     TEXT,
    confidence   TEXT,
    model        TEXT,
    -- attachments: array de { name, mimeType, sizeBytes, dataBase64 }
    -- Solo imagenes en Fase 1 (image/png, image/jpeg, image/webp).
    -- Cuando crezca, migrar a MinIO/S3 y guardar aqui solo metadata + url.
    attachments  JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incidents_created_at        ON incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_module            ON incidents (sap_module);
CREATE INDEX IF NOT EXISTS idx_incidents_client            ON incidents (client_name);
CREATE INDEX IF NOT EXISTS idx_incidents_has_attachments   ON incidents ((jsonb_array_length(attachments) > 0));

-- -----------------------------------------------------
-- audit_logs: trazabilidad de eventos del backend
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action      TEXT NOT NULL,
    details     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_logs (action);

-- -----------------------------------------------------
-- agent_feedback: validacion humana del aprendizaje
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_feedback (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   UUID REFERENCES incidents(id) ON DELETE SET NULL,
    rating        INTEGER CHECK (rating BETWEEN 1 AND 5),
    comment       TEXT,
    validated_by  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_incident ON agent_feedback (incident_id);

-- -----------------------------------------------------
-- knowledge_documents: 1 fila por archivo cargado
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_documents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT,
    source_file  TEXT,
    source_type  TEXT,   -- pdf | docx | xlsx | md | txt
    mime_type    TEXT,
    size_bytes   BIGINT,
    module       TEXT,
    process      TEXT,
    client       TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
                          -- pending | processing | indexed | error
    error_message TEXT,
    chunk_count  INT NOT NULL DEFAULT 0,
    total_tokens INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    indexed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kd_status   ON knowledge_documents (status);
CREATE INDEX IF NOT EXISTS idx_kd_module   ON knowledge_documents (module);
CREATE INDEX IF NOT EXISTS idx_kd_client   ON knowledge_documents (client);
CREATE INDEX IF NOT EXISTS idx_kd_created  ON knowledge_documents (created_at DESC);

-- -----------------------------------------------------
-- knowledge_items: 1 fila por chunk con embedding
-- gemini-embedding-001 / text-embedding-004 → 768 dims
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,
    title        TEXT,
    source_type  TEXT,
    source_file  TEXT,
    module       TEXT,
    process      TEXT,
    client       TEXT,
    chunk_index  INT NOT NULL DEFAULT 0,
    content      TEXT NOT NULL,
    tokens       INT NOT NULL DEFAULT 0,
    embedding    vector(768),
    status       TEXT DEFAULT 'indexed',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_module    ON knowledge_items (module);
CREATE INDEX IF NOT EXISTS idx_knowledge_status    ON knowledge_items (status);
CREATE INDEX IF NOT EXISTS idx_knowledge_document  ON knowledge_items (document_id);
-- Indice vectorial: ivfflat con cosine distance, 100 listas (tipico para 10k-100k filas)
-- Para datasets muy pequeños, postgres usa scan secuencial igual y funciona OK.
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding
  ON knowledge_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- -----------------------------------------------------
-- meetings: reuniones AMS con audio + transcripcion (Fase 5)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         TEXT NOT NULL,
    client        TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
                            -- pending | transcribing | extracting | done | error
    error_message TEXT,
    duration_sec  NUMERIC,
    file_name     TEXT,
    mime_type     TEXT,
    size_bytes    BIGINT,
    -- audio_b64: NO se guarda por defecto (peso). Solo metadatos + transcript.
    transcript    TEXT,
    summary       TEXT,
    -- minute: estructura JSONB con attendees, decisions, actions[], topics, etc.
    minute        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Texto plano de las acciones para queries rapidas / search:
    actions_text  TEXT,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_meetings_created  ON meetings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_status   ON meetings (status);
CREATE INDEX IF NOT EXISTS idx_meetings_client   ON meetings (client);

-- =====================================================
-- Mesa de Soporte con IA (Support Desk, Fase 7)
-- Tablas: support_conversations, support_messages,
-- support_tickets, kb_articles, support_audit
-- Las migraciones detalladas están aplicadas en la DB live
-- desde 2026-05-26. Si vuelves a crear la DB desde cero,
-- consulta la documentación o usa el SQL del repositorio.
-- =====================================================

-- -----------------------------------------------------
-- Canal Telefónico IA (Fase Voice, 2026-05-28)
-- Tablas: call_logs, call_turns
-- También se crean en runtime vía ensureVoiceSchema() para
-- DBs ya en producción que no corren init.sql.
-- No se almacena audio, solo texto.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS call_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_sid          TEXT NOT NULL UNIQUE,
    from_number       TEXT,
    to_number         TEXT,
    call_status       TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at          TIMESTAMPTZ,
    duration_seconds  INTEGER,
    transcript        TEXT,        -- transcripción concatenada del usuario
    ai_responses      TEXT,        -- respuestas concatenadas de la IA
    metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_started ON call_logs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_status  ON call_logs (call_status);

CREATE TABLE IF NOT EXISTS call_turns (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_sid    TEXT NOT NULL,
    speaker     TEXT NOT NULL CHECK (speaker IN ('USER', 'AI', 'SYSTEM')),
    message     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_turns_call_sid ON call_turns (call_sid, created_at);
