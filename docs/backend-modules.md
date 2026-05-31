# Backend modules — bloques BH..BS

Este documento describe los servicios y endpoints que se agregaron al backend
para reemplazar los módulos enterprise del frontend que vivían en localStorage,
más los adaptadores ITSM reales y el análisis IA de video.

## Tablas Postgres creadas

Todas usan `ensureSchema()` idempotente al primer uso (no requiere migración manual).

### BH · Escalation N2
- `escalation_rules` — id, conditions JSONB, sla_minutes, channel, requires_approval
- `n2_responsibles` — id, role, sapModules[], processes[], availability, currentActiveCases
- `escalation_records` — id, status, events JSONB, payload JSONB, sla_target
- `itsm_connectors` — singleton (id=1), payload JSONB
- `escalation_settings` — singleton (id=1), payload JSONB

### BI · Testing Intelligence
- `testing_scenarios` — steps JSONB, evidence_ids[], defect_ids[]
- `testing_evidences` — storage_path (relativo a /app/uploads/testing/)
- `testing_defects` — severity, priority, status, jira_ticket_id (futuro)
- `testing_manuals` — content_markdown
- `testing_settings` — singleton

### BJ · Playbooks AMS
- `playbooks` — steps JSONB
- `playbook_executions` — completed_steps[], notes JSONB

### BK · Document Factory
- `generated_documents` — content (Markdown), form_data JSONB

### BL · Quality Evaluator
- `agent_evaluations` — 4 scores 1-5 + hallucination_risk + technical_level_fit + flags

### BM · RBAC
- `platform_roles` — permissions JSONB
- `platform_users` — role_code, service_level, status

### BN · Auth reforzada (extensiones a tablas existentes)
- `sessions` + columnas `revoked_at`, `last_used_at`, `ip_address`
- `refresh_tokens` — id, user_id, session_id, expires_at, used_at, revoked_at, replaced_by
- `auth_events` — id, user_id, event, ip_address, user_agent, details JSONB

## Endpoints nuevos

```
# Escalation N2
GET    /api/escalation/snapshot
POST   /api/escalation/rules
DELETE /api/escalation/rules/:id
POST   /api/escalation/responsibles
DELETE /api/escalation/responsibles/:id
POST   /api/escalation/records
PATCH  /api/escalation/records/:id
PATCH  /api/escalation/connectors
PATCH  /api/escalation/settings
POST   /api/escalation/reset-demo

# ITSM real (BO + BP)
GET    /api/escalation/itsm/status
POST   /api/escalation/records/:id/send-jira         (body: { payload, confirmReal, by })
POST   /api/escalation/records/:id/send-servicenow

# Testing Intelligence
GET    /api/testing/snapshot
POST   /api/testing/scenarios
DELETE /api/testing/scenarios/:id
POST   /api/testing/evidences                 (JSON: NOTE/LINK/LOG)
POST   /api/testing/evidences/upload          (multipart, hasta 100 MB)
GET    /api/testing/evidences/:id/file        (sirve binario)
DELETE /api/testing/evidences/:id
POST   /api/testing/defects
DELETE /api/testing/defects/:id
POST   /api/testing/manuals
PATCH  /api/testing/settings
POST   /api/testing/reset-demo

# Cloud ALM (BQ)
GET    /api/testing/cloud-alm/status
POST   /api/testing/cloud-alm/export          (body: { payload, confirmReal })

# IA video (BR)
POST   /api/testing/evidences/:id/analyze     (body: { language? }) — usa Whisper + Gemini

# Playbooks
GET    /api/playbooks/snapshot
POST   /api/playbooks
DELETE /api/playbooks/:id
POST   /api/playbooks/executions
DELETE /api/playbooks/executions/:id
POST   /api/playbooks/reset-demo

# Documents
GET    /api/documents/snapshot
POST   /api/documents
DELETE /api/documents/:id
POST   /api/documents/reset-demo

# Quality Evaluator
GET    /api/quality/snapshot
POST   /api/quality/evaluations
DELETE /api/quality/evaluations/:id
POST   /api/quality/reset-demo

# RBAC
GET    /api/rbac/snapshot
POST   /api/rbac/roles
DELETE /api/rbac/roles/:id
POST   /api/rbac/users
DELETE /api/rbac/users/:id
POST   /api/rbac/reset-demo

# Auth reforzada
POST   /api/auth/refresh         (rota refresh token, emite cookies nuevas)
GET    /api/auth/sessions        (lista dispositivos del usuario actual)
POST   /api/auth/logout-all      (revoca todas las sesiones)
```

## Adaptadores ITSM y Cloud ALM

Cada adapter expone `*Status()` para que el frontend muestre el modo actual
sin exponer credenciales. Los tres siguen el mismo patrón:

| Estado env vars | Resultado |
|---|---|
| `*_ENABLED=false` o vacío | mode = `FUTURE` (Cloud ALM) o `DEMO` (Jira/SN). Genera ticket simulado. |
| `*_ENABLED=true` + creds faltantes | mode = `DEMO`, mensaje `credentials_not_configured` |
| `*_ENABLED=true` + creds + `confirmReal=false` | mode = `DEMO`, mensaje `human_confirmation_required` |
| `*_ENABLED=true` + creds + `confirmReal=true` | **REAL** — hace la llamada externa |

**Seguridad inviolable:** los tokens NUNCA salen del backend. El frontend
sólo recibe el `mode` y los flags `authConfigured`. La doble confirmación
(`confirmReal=true`) debe venir de una acción humana explícita en la UI.

## IA de video (Bloque BR)

Pipeline en `testing-video-analysis.service.ts`:

1. Lee el archivo del filesystem (storagePath).
2. POST a Whisper (`/asr?task=transcribe&language=es&output=json`).
3. Pasa el transcript a Gemini con un prompt que extrae `suggestedSteps` y `possibleErrors` como JSON estructurado.
4. Si Gemini no está configurado, hace fallback determinístico (splits por puntos).
5. Devuelve `{ transcript, suggestedSteps[], possibleErrors[], rawGeminiResponse }`.

Límite de transcript: 8000 caracteres al prompt de Gemini (suficiente para ~30 min de video).
Máximo 12 pasos sugeridos por análisis.

## Auth reforzada (Bloque BN)

- **Bcrypt 12 rounds por default** (configurable con `AUTH_BCRYPT_ROUNDS`).
- **Refresh tokens** en tabla separada con rotación: cada vez que se usa un refresh,
  se marca `used_at` y se emite uno nuevo (`replaced_by`).
- **Detección de reuso**: si un refresh ya usado se intenta usar de nuevo →
  asumimos compromiso, revocamos toda la familia del usuario (`REVOKE_ALL`).
- **Sesiones soft-delete** con `revoked_at` (auditable).
- **`last_used_at`** se actualiza en cada `getUserBySession`.
- **Audit log** en `auth_events`: LOGIN_SUCCESS, LOGIN_FAIL, LOGOUT, REFRESH,
  REVOKE_ALL, SIGNUP — con IP y user-agent.
- **`GET /api/auth/sessions`** lista dispositivos activos del usuario actual.
- **`POST /api/auth/logout-all`** revoca todo.

## Sentry (Bloque BS)

- Activo sólo si `SENTRY_DSN` está seteada. Si no, todas las funciones son no-op.
- Backend: captura sólo errores 5xx (no 4xx que son ruido).
- Frontend: lazy load del SDK para no inflar el bundle si no se usa.
- `tracesSampleRate` default 0.05 (5% de las requests). Subir a 1.0 sólo en dev.
- **No envía PII por default** (`sendDefaultPii: false`).
