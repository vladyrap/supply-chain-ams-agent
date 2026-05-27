# Futuro — Voz (Fase 5)

## Objetivo

Permitir interacción por voz con el agente AMS. Útil para:
- Reuniones AMS donde el consultor describe un incidente hablando.
- Modo "manos libres" durante operaciones de cutover o hypercare.
- Transcripción automática de minutas con extracción de acciones AMS.

## Componentes

### Speech-to-Text (STT)
- Opción A: **Deepgram** (latencia baja, multilenguaje, español-CL/AR/MX bien soportado).
- Opción B: **Whisper** (open-source, on-prem posible).
- Opción C: **Anthropic** — si en el futuro Claude soporta audio nativo.

### Text-to-Speech (TTS)
- Opción A: **ElevenLabs** (voces naturales en español).
- Opción B: **Azure Speech** (voces neuronales corporativas).
- Opción C: **Google Cloud TTS**.

### Modo reunión AMS
- Captura de audio de Zoom/Teams/Meet.
- Transcripción en streaming.
- Diarización (quién habló).
- Resumen ejecutivo + lista de acciones extraídas por Claude.
- Guardado en `knowledge_items` como `source_type="meeting"`.

## Esquema sugerido

```sql
CREATE TABLE meetings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT,
  client       TEXT,
  attendees    TEXT[],
  duration_sec INT,
  audio_url    TEXT,
  transcript   TEXT,
  summary      TEXT,
  actions      JSONB,
  created_at   TIMESTAMPTZ DEFAULT now()
);
```

## API esperada (Fase 5)

- `POST /api/voice/stream` — websocket para audio en vivo, devuelve texto en streaming.
- `POST /api/voice/synthesize` — recibe texto, devuelve audio.
- `POST /api/meetings/upload` — sube audio de reunión, encola job de transcripción + resumen.
- `GET /api/meetings/:id` — devuelve transcript + summary + actions.

## Consideraciones

- Costo: voz es más cara que texto; presupuestar por cliente.
- Privacidad: audio puede contener PII; cifrado en reposo, retención limitada.
- Latencia: < 300ms para conversación natural; usar streaming en ambos sentidos.
- Acentos: validar con muestras de español de Chile, Argentina, México y España.
