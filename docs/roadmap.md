# Roadmap — supply-chain-ams-agent

## Fase 1 (actual)
- Chat AMS con Claude Opus 4.7.
- Persistencia de incidentes y auditoría en Postgres.
- Frontend Next.js con formulario y visualización de respuesta.
- Docker Compose con stack completo.
- Observabilidad base (Prometheus + Grafana + ELK stack listo).

## Fase 2 — RAG documental
- Carga de PDF, Word, Excel y minutas.
- Chunking + embeddings (voyage-3 sugerido).
- Almacenamiento vectorial (pgvector dentro de `ams_agent`).
- Búsqueda semántica con filtros (módulo, cliente, tipo).
- Citas obligatorias en respuestas.
- Activación del `future-rag-prompt.md`.

## Fase 3 — Integración con sistemas de tickets
- Conector Jira (lectura + creación).
- Conector ServiceNow.
- Conector SAP Cloud ALM.
- Clasificación automática de tickets entrantes.
- Respuesta sugerida al cliente (no envío automático; aprobación humana).

## Fase 4 — SAP modo lectura
- Cliente OData / RFC read-only para S/4HANA y ECC.
- Tool use Claude con catálogo blanco de endpoints.
- Diagnóstico con datos reales (consultar OC, pedidos, entregas, facturas, etc.).
- Activación del `future-sap-readonly-prompt.md`.
- Bloque 13 "Consultas SAP ejecutadas" en cada respuesta.

## Fase 5 — Voz
- Speech-to-text para entrada en reuniones AMS.
- Text-to-speech para respuesta hablada.
- Modo reunión AMS: transcripción + resumen + acciones.
- Detalle en `docs/future-voice.md`.

## Fase 6 — Acciones controladas
- Ejecución solo en DEV/QA, jamás PRD.
- Aprobación humana obligatoria antes de cada acción.
- Auditoría avanzada: quién aprobó, cuándo, qué se ejecutó, resultado.
- Roles y autorizaciones.
- Login y multi-tenant.

## Fuera de scope (todavía)
- Kubernetes / Cloud deploy.
- MCP servers propios (queda documentado para futuro).
- Multi-idioma (por ahora solo español).
- Mobile app.
