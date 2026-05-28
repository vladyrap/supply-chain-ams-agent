# supply-chain-ams-agent

> **Agente AMS Supply Chain** — consultor senior SAP impulsado por LLM (Gemini 2.5 Flash en Fase 1, intercambiable a Claude) para clasificar, diagnosticar y guiar la resolución de incidentes de cadena de suministro (MM, SD, PP, WM/EWM, QM, PM, Ariba, IBP, integraciones).

---

## 1. Descripción

`supply-chain-ams-agent` es un sistema local en Docker que conecta una UI de chat con la API de Claude (Anthropic) para entregar diagnóstico estructurado de incidentes SAP Supply Chain. La respuesta sigue un formato de 12 bloques (clasificación, módulo, proceso, severidad, datos faltantes, causas raíz, paso a paso, riesgos, prueba, respuesta al cliente, confianza, aprendizaje).

## 2. Objetivo del agente

Apoyar a consultores y equipos AMS en:

- Clasificación rápida de tickets.
- Diagnóstico funcional/técnico inicial.
- Generación de paso a paso recomendado.
- Documentación de incidentes y RCA.
- Redacción de respuesta al cliente.
- Sugerencia de pruebas funcionales.

## 3. Alcance de la versión inicial (Fase 1)

✅ Chat con Gemini 2.5 Flash (tier gratuito)
✅ Persistencia en Postgres
✅ Auditoría de eventos
✅ Frontend Next.js
✅ Observabilidad base (Prometheus, Grafana, ELK preparado)

🚫 **NO** ejecuta cambios en SAP
🚫 **NO** tiene login
🚫 **NO** procesa archivos (RAG llega en Fase 2)
🚫 **NO** tiene voz (Fase 5)
🚫 **NO** se conecta a SAP (Fase 4)

## 4. Arquitectura

Ver [docs/architecture.md](docs/architecture.md) para el diagrama completo.

Resumen: navegador → `ams-frontend` (Next.js) → `ams-backend` (Fastify) → Claude API + Postgres + Redis.
Observabilidad: Prometheus scrape `/metrics` del backend, Grafana con datasource preconfigurado.
ELK stack levantado y listo para Fase 2.

## 5. Servicios Docker

| Container | Stack | Puerto host |
|---|---|---|
| `supply-chain-ams-frontend` | Next.js 14 + TS | **6600** |
| `supply-chain-ams-backend`  | Node 20 + Fastify + TS | **6601** |
| `supply-chain-ams-worker`   | Node 20 + TS (stub) | — |
| `supply-chain-ams-db`       | Postgres 16 | **6602** |
| `supply-chain-ams-redis`    | Redis 7 | **6603** |
| `supply-chain-ams-kibana`   | Kibana 8.13 | **6604** |
| `supply-chain-ams-grafana`  | Grafana | **6605** |
| `supply-chain-ams-prometheus` | Prometheus | **6609** |
| `supply-chain-ams-logstash` | Logstash 8.13 | **6610** |
| `supply-chain-ams-elasticsearch` | Elasticsearch 8.13 | **6620** |

Red única: `supply-chain-ams-network`.
Volúmenes únicos: `supply-chain-ams-postgres-data`, `-redis-data`, `-elasticsearch-data`, `-kibana-data`, `-prometheus-data`, `-grafana-data`.

## 6. Puertos

Todos los puertos host están en el rango **66xx** (excepto Elasticsearch en 6620) para no colisionar con otros proyectos.

## 7. Variables de entorno

Copiar `.env.example` a `.env` y completar:

```bash
cp .env.example .env
```

Editar `.env` y poner tu `GEMINI_API_KEY` (obtenla gratis en <https://aistudio.google.com/app/apikey>). El modelo por defecto es `gemini-2.5-flash` (tier free).

## 8. Instalación

Requisitos:
- Docker Desktop 4.x con Compose v2.
- 8 GB de RAM libres (Elasticsearch pide su parte).

No requiere instalar Node ni Python en el host: todo corre en contenedores.

## 9. Cómo levantar

```bash
cd /c/Users/VMATTA/Desktop/supply-chain-ams-agent

# 1) Configurar .env con tu API key
cp .env.example .env
# editar .env con tu editor favorito y reemplazar GEMINI_API_KEY
# (obtener key gratis en https://aistudio.google.com/app/apikey)

# 2) Validar compose
docker compose config --quiet

# 3) Build + up
docker compose up --build -d

# 4) Ver el estado
docker compose ps
```

El primer build tarda 5–10 min (descarga imágenes + npm install).

## 10. Cómo detener

```bash
# Detener pero mantener datos
docker compose stop

# Detener y borrar contenedores (datos persisten en volúmenes)
docker compose down

# Detener y borrar TODO incluido data (cuidado)
docker compose down -v
```

## 11. Cómo probar backend

```bash
curl http://localhost:6601/health
# -> {"success":true,"service":"ams-backend","status":"ok","timestamp":"..."}

curl http://localhost:6601/health/deep
# -> incluye check de Postgres
```

## 12. Cómo probar frontend

Abrir en navegador: <http://localhost:6600>

Pantalla con formulario:
- Incidente o pregunta (textarea)
- Usuario, Cliente
- Módulo SAP (select), Ambiente (select)
- Botón "Enviar al agente"

## 13. Cómo revisar logs

```bash
# Logs en vivo de todos los servicios
docker compose logs -f

# Solo backend
docker compose logs -f backend

# Solo frontend
docker compose logs -f frontend
```

## 14. Acceder a Grafana

URL: <http://localhost:6605>
Usuario: `admin`
Password: `admin`
Datasource Prometheus preconfigurado (`supply-chain-ams-prometheus:9090`).

## 15. Acceder a Kibana

URL: <http://localhost:6604>
Sin autenticación en local. Para Fase 2 cuando logstash empiece a enviar logs.

## 16. Acceder a Prometheus

URL: <http://localhost:6609>
Target `ams-backend` configurado en `/metrics`.

## 17. Comando curl de prueba (POST /api/ams/chat)

```bash
curl -X POST http://localhost:6601/api/ams/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "No puedo contabilizar una entrada de mercancía contra una orden de compra",
    "user": "consultor_ams",
    "module": "MM",
    "client": "demo",
    "environment": "DEV"
  }'
```

## 18. Ejemplo de respuesta

```json
{
  "success": true,
  "agent": "ams-supply-chain-agent",
  "input": {
    "message": "No puedo contabilizar...",
    "user": "consultor_ams",
    "module": "MM",
    "client": "demo",
    "environment": "DEV"
  },
  "response": "1. **Clasificación del caso**\n   Incidente operativo en proceso Procure to Pay...\n\n2. **Módulo SAP probable**\n   MM (Materials Management)...\n\n...12 bloques completos...",
  "metadata": {
    "model": "gemini-2.5-flash",
    "timestamp": "2026-05-25T12:00:00.000Z",
    "confidence": "media"
  }
}
```

Ver más detalle en [docs/api.md](docs/api.md).

## 19. Problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `GEMINI_API_KEY no está configurada` | Falta `.env` o key vacía | Editar `.env`, reiniciar backend: `docker compose restart backend` |
| Frontend muestra "Error de red" | Backend no levantó o CORS | `docker compose logs backend`, verificar healthcheck |
| Elasticsearch en estado restarting | RAM insuficiente | Ajustar `ES_JAVA_OPTS=-Xms256m -Xmx256m` en `docker-compose.yml` |
| Puerto 66xx en uso | Otro proceso lo tomó | `netstat -ano | findstr :6601` y cerrar el proceso, o cambiar el puerto host en compose |
| DB no inicializa tablas | Volumen viejo de otra prueba | `docker compose down -v` y volver a `up` |

## 20. Roadmap

Ver [docs/roadmap.md](docs/roadmap.md).

- Fase 2: RAG documental (PDF/Word/Excel + embeddings + pgvector).
- Fase 3: Conectores Jira / ServiceNow / SAP Cloud ALM.
- Fase 4: SAP modo lectura (OData / RFC read-only).
- Fase 5: Voz (STT + TTS + modo reunión AMS).
- Fase 6: Acciones controladas con aprobación humana.

## 21. Reglas de seguridad

Ver [docs/security.md](docs/security.md).

Resumen:
- `ANTHROPIC_API_KEY` nunca se loggea (redact pino).
- System prompt separado del input del usuario (anti prompt injection).
- Stacktrace nunca expuesto.
- Whitelist de módulos y ambientes.
- Validación de UUIDs.
- Auditoría completa en `audit_logs`.

## 22. Advertencia operacional

> Esta versión del agente **NO toca SAP ni ningún sistema productivo**. Solo diagnostica, clasifica, documenta y recomienda. Toda recomendación debe validarse en DEV/QA antes de productivo y requiere aprobación humana, control de cambios y respaldo.

---

---

## Atención telefónica con IA (Canal Voice)

### Qué hace

Permite que un cliente **llame por teléfono** a un número configurado y sea atendido por la IA del agente AMS. La llamada se procesa con reconocimiento de voz (STT) y la respuesta del agente se sintetiza a voz (TTS) — todo orquestado por Twilio Voice.

Flujo end-to-end:

1. Cliente marca el número Twilio configurado
2. Twilio hace `POST /api/voice/incoming` con el `CallSid`
3. Backend responde TwiML con saludo + `<Gather input="speech">`
4. Cliente habla; Twilio transcribe y hace `POST /api/voice/process-speech` con `SpeechResult`
5. Backend envía el texto al agente (modelo `gemini-2.5-flash-lite` + `prompts/voice-system-prompt.md`)
6. Gemini responde en estilo conversacional breve (sin markdown, frases cortas)
7. Backend devuelve TwiML con `<Say>` (TTS) y nuevo `<Gather>` para continuar
8. Twilio hace `POST /api/voice/status` cuando la llamada termina; el backend cierra el `call_log`

### Proveedor

**Twilio Voice** en esta primera versión. El módulo está estructurado con una interfaz `VoiceProvider` para que más adelante se pueda agregar **Vonage**, **Telnyx**, **SIP propio**, **Asterisk** o cualquier PBX sin tocar los controllers.

### Variables de entorno

```
TWILIO_ACCOUNT_SID=ACxxxxxxxx...
TWILIO_AUTH_TOKEN=xxxxxxxx...
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx
VOICE_DEFAULT_LANGUAGE=es-CL
VOICE_DEFAULT_VOICE=alice
VOICE_AGENT_MODE=SUPPORT
GEMINI_VOICE_MODEL=gemini-2.5-flash-lite
VOICE_MAX_OUTPUT_TOKENS=220
```

Todas son opcionales en MVP. Sin `TWILIO_AUTH_TOKEN` el módulo arranca pero NO valida la firma de los webhooks (modo dev).

### Endpoints nuevos

| Método | Ruta | Para qué |
|--------|------|----------|
| `POST` | `/api/voice/incoming` | Webhook que Twilio llama al recibir una llamada. Responde TwiML con saludo + Gather |
| `POST` | `/api/voice/process-speech` | Webhook tras el Gather. Envía `SpeechResult` al agente y responde TwiML con la respuesta + nuevo Gather |
| `POST` | `/api/voice/status` | Status callback de Twilio (ringing, completed, busy, failed…). Persiste duración y cierra el call_log |
| `GET`  | `/api/voice/calls` | Listado de llamadas (números enmascarados) |
| `GET`  | `/api/voice/calls/:callSid` | Detalle de una llamada con sus turnos (USER/AI/SYSTEM) |

### Configurar el webhook en Twilio

1. Twilio Console → **Phone Numbers → Manage → Active Numbers**
2. Hacer click en el número adquirido
3. Sección **Voice Configuration**:
   - **A call comes in** → `Webhook` → `POST` → `https://<tu-dominio>/api/voice/incoming`
   - **Call status changes** → `https://<tu-dominio>/api/voice/status`

### Probar localmente con ngrok

Twilio necesita una URL **pública** (HTTPS). Para desarrollo:

```bash
# 1) Levantar el stack
docker compose -f supply-chain-ams-stack/docker-compose.yml up -d

# 2) Exponer el backend (puerto host 6601)
ngrok http 6601

# 3) Copiar la URL https que da ngrok, por ejemplo:
#    https://abc1234.ngrok-free.app
#
# 4) En Twilio configurar como webhook:
#    Voice:  https://abc1234.ngrok-free.app/api/voice/incoming  (POST)
#    Status: https://abc1234.ngrok-free.app/api/voice/status    (POST)
#
# 5) Llamar al número desde tu celular
```

### Tablas que se crean

```sql
call_logs  (id, call_sid UNIQUE, from_number, to_number, call_status,
            started_at, ended_at, duration_seconds,
            transcript, ai_responses, metadata jsonb, created_at)
call_turns (id, call_sid, speaker IN ('USER','AI','SYSTEM'),
            message, created_at)
```

Se crean automáticamente al arranque del backend vía `ensureVoiceSchema()` (idempotente). También están en `database/init.sql` para deploys nuevos.

### Limitaciones del MVP

- ❌ No hay llamadas salientes (sólo entrantes)
- ❌ No conecta SAP (igual que el resto del agente)
- ❌ No requiere login (los webhooks de Twilio son sin auth de cookie)
- ❌ No usa RAG todavía (la voz no consulta documentación, solo el LLM puro con voice-prompt)
- ⚠️ Validación de firma `X-Twilio-Signature` implementada pero **no enforced** por default. Habilitar antes de producción
- ⚠️ El idioma y la voz se setean por env. Para cambiar mid-call se requiere refactor

### Consideraciones de privacidad

- **No se guarda audio.** Sólo el texto transcrito por Twilio (consentimiento del usuario aplica al llamar)
- Los números de teléfono se **enmascaran en logs** (`+56912345678` → `+56****5678`) vía `maskPhone()`
- Las credenciales Twilio nunca se exponen en logs ni en respuestas
- Cada llamada genera una fila en `call_logs` y N filas en `call_turns`, accesibles solo por API interna
- TODO: agregar TTL de retención + endpoint de borrado por solicitud (GDPR/LGPD)

---

## Estructura del proyecto

```
supply-chain-ams-agent/
├── docker-compose.yml
├── .env.example
├── .gitignore
├── README.md
├── frontend/                  Next.js 14 + TS
├── backend/                   Fastify + TS
├── worker/                    Node 20 + TS (stub)
├── prompts/                   System prompt + 4 future prompts
├── database/                  init.sql
├── observability/             prometheus, grafana, logstash configs
└── docs/                      arquitectura, roadmap, api, security, futuros
```
