# Seguridad — supply-chain-ams-agent

## Principios

1. **No ejecutar en productivo.** Esta versión solo diagnostica. No toca SAP ni ningún sistema externo.
2. **Aprobación humana obligatoria** para cualquier acción futura.
3. **Separación de ambientes** declarada explícitamente (DEV / QA / SANDBOX / PRD).
4. **Auditoría completa** en `audit_logs`.

## Manejo de claves

- `GEMINI_API_KEY` se lee desde `.env` (nunca commiteado, `.gitignore` lo bloquea).
- El logger pino tiene `redact` para `GEMINI_API_KEY`, `apiKey`, `authorization`, `cookie`.
- La clave nunca aparece en stdout, audit_logs ni response al cliente.
- Si la clave no está configurada, el backend responde 500 con mensaje claro y no expone más detalle.

## Aislamiento del prompt

- El `system prompt` se envía a Claude por el campo `system`, separado de `messages`.
- El mensaje del usuario se serializa como contenido de usuario, **no se interpreta como instrucción de sistema**.
- Esto reduce el riesgo de prompt injection (un usuario no puede "convencer" al modelo de saltarse las reglas modificando el system prompt, porque no tiene acceso a ese canal).

## Validación de input

- `message` obligatorio, string, no vacío, máximo 8000 caracteres.
- `module` y `environment` con whitelist estricta; cualquier valor fuera cae a `NO_INFORMADO`.
- UUIDs validados con regex antes de la query a Postgres.

## Manejo de errores

- Stacktrace **nunca** expuesto al cliente.
- Errores 5xx devuelven mensaje genérico: "Error procesando la solicitud del agente AMS".
- Errores 4xx devuelven mensaje legible pero sin datos internos.
- Todo error se registra en `audit_logs` con `action='ERROR'`.

## CORS

- En Fase 1 (local dev): `origin: true` (cualquier origen).
- En Fase 2+: configurar whitelist por entorno.

## Rate limiting

- No implementado en Fase 1.
- Sugerido para Fase 2: `@fastify/rate-limit`, 60 req/min por IP.

## Roles y autorizaciones (futuro)

- Fase 6: login + roles (consultor, lead, aprobador).
- Solo aprobador puede confirmar acciones que toquen SAP DEV/QA.
- Productivo siempre requiere control de cambios fuera del agente.

## Datos sensibles SAP (futuro)

- Cuando se active Fase 4 (SAP read-only):
  - No loggear payloads con PII (RUT, email, número fiscal).
  - Catálogo blanco de endpoints permitidos.
  - Límite de filas por consulta (top 50 default).
  - Sin acceso a tablas con precios sensibles, contratos confidenciales.

## Advertencia operacional

> Esta versión del agente **no ejecuta** cambios en SAP. Cualquier recomendación que entregue debe validarse en DEV/QA antes de productivo, y requiere aprobación humana, control de cambios y respaldo.
