# API — supply-chain-ams-agent

Base URL local: `http://localhost:6601`

Todos los endpoints retornan JSON con la forma:
- Éxito: `{ "success": true, ...datos }`
- Error: `{ "success": false, "error": "mensaje legible" }`

---

## GET /health

Liveness check. No consulta dependencias.

**200 OK**
```json
{
  "success": true,
  "service": "ams-backend",
  "status": "ok",
  "timestamp": "2026-05-25T12:00:00.000Z"
}
```

---

## GET /health/deep

Readiness check. Verifica Postgres.

**200 OK** o **500** (si falla DB)
```json
{
  "success": true,
  "service": "ams-backend",
  "status": "ok",
  "checks": { "db": "ok" },
  "timestamp": "2026-05-25T12:00:00.000Z"
}
```

---

## GET /metrics

Métricas Prometheus en texto plano.

Contadores expuestos:
- `ams_http_requests_total{method,route,status}`
- `ams_http_request_duration_seconds{method,route,status}` (histograma)
- `ams_claude_requests_total{model,result}`
- Métricas default Node.js (CPU, memoria, event loop, GC).

---

## POST /api/ams/chat

Enviar incidente o pregunta al agente.

**Request**
```json
{
  "message": "No puedo contabilizar una entrada de mercancía contra una orden de compra",
  "user": "consultor_ams",
  "module": "MM",
  "client": "demo",
  "environment": "DEV"
}
```

Campos:
- `message` (string, obligatorio, ≤ 8000 chars).
- `user` (string, opcional, default `"anonymous"`).
- `module` (string, opcional, default `"NO_INFORMADO"`). Whitelist: `NO_INFORMADO, MM, SD, PP, WM, EWM, QM, PM, ARIBA, IBP, BTP, INTEGRACION`. Cualquier otro valor cae a `NO_INFORMADO`.
- `client` (string, opcional, default `"NO_INFORMADO"`).
- `environment` (string, opcional, default `"NO_INFORMADO"`). Whitelist: `NO_INFORMADO, DEV, QA, PRD, SANDBOX`.

**200 OK**
```json
{
  "success": true,
  "agent": "ams-supply-chain-agent",
  "input": {
    "message": "...",
    "user": "consultor_ams",
    "module": "MM",
    "client": "demo",
    "environment": "DEV"
  },
  "response": "1. Clasificación del caso\n...",
  "metadata": {
    "model": "gemini-2.5-flash",
    "timestamp": "2026-05-25T12:00:00.000Z",
    "confidence": "media"
  }
}
```

**400 Bad Request** (validación)
```json
{ "success": false, "error": "El campo message es obligatorio" }
```

**500** (configuración o Claude)
```json
{ "success": false, "error": "GEMINI_API_KEY no está configurada" }
```
```json
{ "success": false, "error": "Error procesando la solicitud del agente AMS" }
```

---

## GET /api/ams/incidents

Últimos 50 incidentes, orden descendente por `created_at`.

```json
{
  "success": true,
  "count": 12,
  "incidents": [
    {
      "id": "uuid",
      "user_name": "consultor_ams",
      "client_name": "demo",
      "sap_module": "MM",
      "environment": "DEV",
      "message": "...",
      "response": "...",
      "confidence": "media",
      "model": "gemini-2.5-flash",
      "created_at": "2026-05-25T12:00:00.000Z"
    }
  ]
}
```

---

## GET /api/ams/incidents/:id

Un incidente específico por UUID.

- **400** si el `id` no tiene formato UUID.
- **404** si no existe.
- **200** con `{ success: true, incident: {...} }`.

---

## GET /api/ams/audit

Últimos 100 eventos de auditoría.

```json
{
  "success": true,
  "count": 87,
  "audit": [
    {
      "id": "uuid",
      "action": "INCIDENT_SAVED",
      "details": { "incidentId": "uuid" },
      "created_at": "2026-05-25T12:00:00.000Z"
    }
  ]
}
```

Acciones registradas: `CHAT_REQUEST_RECEIVED`, `CLAUDE_REQUEST_SENT`, `CLAUDE_RESPONSE_RECEIVED`, `INCIDENT_SAVED`, `ERROR`.
