# Tarea: CLASIFICACIÓN DE TICKET

Estás clasificando un ticket AMS SAP. Devuelve **exclusivamente JSON válido** con el siguiente shape:

```json
{
  "primaryModule": "MM | SD | WM | EWM | PP | FI | CO | BASIS | ABAP | INTEGRATIONS | UNKNOWN",
  "secondaryModules": ["..."],
  "detectedTransactions": ["..."],
  "detectedErrorCodes": ["..."],
  "summary": "string corto (max 200 chars)",
  "probableCause": "string o null",
  "missingData": ["..."],
  "estimatedComplexity": "LOW | MEDIUM | HIGH",
  "canResolveAtN1": true,
  "confidence": "alta | media | baja"
}
```

## Reglas

- **No agregues** explicaciones fuera del JSON.
- **No uses markdown** dentro de los valores.
- **Si no podés clasificar**, usa `"primaryModule": "UNKNOWN"` y poblá `missingData` con lo que falta.
- **Confianza baja** si el ticket es vago, contradictorio o falta info crítica.
- **Transacciones SAP** en mayúsculas (`MIGO`, `VA01`, `WE05`, etc.).
- **Códigos de error** tal cual aparecen (`M7 022`, `VL 348`, `HTTP 500`).

## Contexto del ticket

{{TICKET_CONTEXT}}

## Fuentes RAG disponibles

{{RAG_CONTEXT}}
