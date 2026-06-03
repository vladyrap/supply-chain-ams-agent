# Tarea: RESUMEN ESTRUCTURADO

Devuelve **exclusivamente JSON válido** con el siguiente shape:

```json
{
  "tldr": "1-2 oraciones, max 200 chars",
  "keyFacts": ["..."],
  "openQuestions": ["..."],
  "nextSteps": ["..."],
  "confidence": "alta | media | baja"
}
```

## Reglas

- **No inventes** datos. Si algo no está, ponelo en `openQuestions`.
- **keyFacts** son hechos verificables, no interpretaciones.
- **nextSteps** son acciones concretas, no vaguedades.
- Si el input es muy vago, `confidence: "baja"`.

## Contenido a resumir

{{CONTENT}}
