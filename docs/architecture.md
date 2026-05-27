# Arquitectura — supply-chain-ams-agent

## Diagrama textual

```
+----------------------+        HTTP        +----------------------+
|  Navegador (usuario) | <----------------> |  ams-frontend (Next) |
|  http://localhost:6600|                    |  contenedor :3000   |
+----------------------+                    +----------+-----------+
                                                       |
                                            fetch JSON | NEXT_PUBLIC_API_URL
                                                       v
+----------------------+        REST        +----------------------+
|  ams-backend Fastify | <----------------> |  Claude API (Anthropic)
|  contenedor :8000    |  Anthropic SDK     |  modelo: claude-opus-4-7
|  host: 6601          |                    +----------------------+
+----+------+----+-----+
     |      |    |
     | pg   | redis (futuro)
     v      v
+--------+ +--------+
| ams-db | | ams-redis|
+--------+ +--------+

+---------------------+   +------------------+   +-----------------+
| ams-prometheus      |-->| ams-backend      |   | ams-grafana     |
| scrape /metrics     |   | /metrics endpoint|   | datasource prom |
+---------------------+   +------------------+   +-----------------+

+---------------+    +------------+    +-----------+
| ams-logstash  |--> | ams-elastic|<-->| ams-kibana|
| (Fase futura) |    |   search   |    |           |
+---------------+    +------------+    +-----------+

+----------------+
| ams-worker     |  stub. Fase 2: PDFs, embeddings, reindex, learning
+----------------+
```

## Descripción de cada servicio

| Servicio | Imagen / Stack | Puerto host | Rol |
|---|---|---|---|
| ams-frontend | Next.js 14 + TS, standalone | 6600 → 3000 | UI de chat, formulario, render respuesta |
| ams-backend  | Node 20 + Fastify + TS | 6601 → 8000 | REST API, orquesta Claude + DB + audit |
| ams-worker   | Node 20 + TS (stub) | — | Tareas asíncronas (Fase 2) |
| ams-db       | postgres:16-alpine | 6602 → 5432 | Persistencia incidentes, audit, feedback, knowledge |
| ams-redis    | redis:7-alpine | 6603 → 6379 | Caché y colas (Fase 2) |
| ams-elasticsearch | elasticsearch:8.13 | 6620 → 9200 | Storage de logs (Fase 2) |
| ams-kibana   | kibana:8.13 | 6604 → 5601 | UI logs |
| ams-logstash | logstash:8.13 | 6610 → 5044 | Pipeline de logs hacia ES |
| ams-prometheus | prom/prometheus | 6609 → 9090 | Scrape /metrics del backend |
| ams-grafana  | grafana/grafana | 6605 → 3000 | Dashboards |

Red Docker única: `supply-chain-ams-network`.

## Flujo de request (chat AMS)

1. El navegador envía `POST http://localhost:6601/api/ams/chat` con `{ message, user?, module?, client?, environment? }`.
2. `ams.controller.normalize()` valida (`message` obligatorio, ≤ 8000 chars, módulo/ambiente whitelisteados).
3. `audit.service.recordAudit("CHAT_REQUEST_RECEIVED")` → `audit_logs`.
4. `claude.service.chatWithAgent()`:
   - Carga `prompts/ams-system-prompt.md` (cacheado en memoria).
   - Instancia cliente Anthropic con `ANTHROPIC_API_KEY`.
   - Envía con `system` separado del `user` (evita prompt injection del input).
   - Lee `ANTHROPIC_MODEL` (default `claude-opus-4-7`).
5. `audit.recordAudit("CLAUDE_RESPONSE_RECEIVED")`.
6. `detectConfidence()` parsea el bloque 11 de la respuesta → `baja/media/alta/no_detectada`.
7. `incident.service.saveIncident()` → `incidents`.
8. `audit.recordAudit("INCIDENT_SAVED")`.
9. Respuesta JSON al frontend con `response`, `metadata.model`, `metadata.timestamp`, `metadata.confidence`.

## Flujo de guardado en base de datos

- Tabla `incidents`: una fila por interacción (input + respuesta + confianza + modelo).
- Tabla `audit_logs`: una fila por evento del backend (`CHAT_REQUEST_RECEIVED`, `CLAUDE_REQUEST_SENT`, `CLAUDE_RESPONSE_RECEIVED`, `INCIDENT_SAVED`, `ERROR`).
- Tabla `agent_feedback`: vacía en Fase 1, pensada para validación humana (rating 1-5, comentario, `validated_by`).
- Tabla `knowledge_items`: vacía en Fase 1, lista para Fase 2 (RAG).

## Flujo futuro RAG (Fase 2)

```
PDF/Word/Excel --> [worker: parse + chunk]
              --> [worker: embeddings (voyage-3)]
              --> [pgvector / ams-db.knowledge_items]
chat request  --> [backend: retrieve top-k]
              --> [Claude system prompt + chunks como contexto]
              --> respuesta con citas
```

## Flujo futuro SAP modo lectura (Fase 4)

```
chat request --> [backend: tool-use Claude]
             --> [backend: SAP read-only client (OData / RFC read-only)]
             --> respuesta con datos reales + bloque 13 "Consultas SAP ejecutadas"
```

Reglas: solo endpoints en catálogo blanco, sin escritura, límites por defecto, sin PII en logs.
