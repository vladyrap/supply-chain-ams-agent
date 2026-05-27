# Futuro — RAG documental (Fase 2)

## Objetivo

Permitir al agente AMS responder usando documentación interna del cliente: manuales SAP, blueprints, minutas, notas OSS guardadas, runbooks AMS, lecciones aprendidas.

## Componentes

### Ingesta
- Worker procesa archivos cargados (PDF, DOCX, XLSX, MD, TXT).
- Extracción: `pdf-parse` para PDF, `mammoth` para DOCX, `xlsx` para Excel.
- Limpieza: normalizar saltos de línea, quitar headers/footers repetidos.

### Chunking
- Tamaño: 800–1200 tokens.
- Overlap: ~100 tokens.
- Metadatos por chunk: `source_file`, `page`, `module`, `process`, `client`, `created_at`.

### Embeddings
- Modelo sugerido: **voyage-3** (1024 dims, óptimo para documentación técnica).
- Alternativa: `text-embedding-3-large` (3072 dims) si se requiere mayor precisión.
- Almacenamiento: extensión **pgvector** en la misma `ams_agent`.

### Esquema sugerido

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE knowledge_items
  ADD COLUMN embedding vector(1024),
  ADD COLUMN tokens INT,
  ADD COLUMN page INT,
  ADD COLUMN source_file TEXT,
  ADD COLUMN client TEXT;

CREATE INDEX ON knowledge_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### Retrieval

1. Embedding de la pregunta.
2. Búsqueda top-k (k=8) con filtros por `module`, `client`, `process`.
3. Reranking opcional con `cohere-rerank` o `claude-haiku-4-5` como reranker liviano.
4. Inyección de los chunks en el `system` o como `user` con prefijo `[CONTEXTO RAG]`.

### Citas

- Cada chunk usado se cita en el bloque 13 de la respuesta: `[fuente: nombre_documento, página/sección, score]`.
- Si no hay matches razonables (score < umbral), el agente responde con conocimiento general y lo declara.

## API nueva esperada

- `POST /api/knowledge/ingest` — sube archivo, encola job en worker.
- `GET /api/knowledge/items` — lista lo indexado, con filtros.
- `DELETE /api/knowledge/items/:id` — borra un item.
- `POST /api/ams/chat` — sin cambios de contrato, pero internamente activa retrieval si `RAG_ENABLED=true`.

## Riesgos

- Documentos con PII: filtrar antes de indexar.
- Versiones contradictorias del mismo proceso: priorizar más reciente o marcada como oficial.
- Costos de embeddings: budget por cliente.
