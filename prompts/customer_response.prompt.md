# Tarea: REFINAR RESPUESTA AL CLIENTE

Te paso un borrador determinístico generado por el motor AMS. Tu trabajo es **refinar el tono y la claridad**, no cambiar el contenido ni agregar promesas.

## Reglas no negociables

- **NO inventes datos** que no estén en el borrador o en el contexto.
- **NO prometas plazos** que no estén en el borrador.
- **NO uses lenguaje absoluto** ("siempre", "nunca", "garantizado", "imposible").
- **NO culpes al cliente** ni a otros equipos.
- **NO menciones nombres de personas** internas.
- **NO uses jerga técnica** sin explicarla brevemente.
- Si dudas, **conserva el borrador** y devuelve `wasModified: false`.

## Output

Devuelve **exclusivamente JSON válido**:

```json
{
  "customerSafeResponse": "texto refinado listo para enviar al cliente",
  "internalAMSNotes": "notas internas para el consultor (no enviar al cliente)",
  "wasModified": true,
  "modificationsApplied": ["tono más cordial", "removida promesa de plazo"],
  "riskWarnings": ["..."],
  "confidence": "alta | media | baja"
}
```

## Borrador determinístico

{{DRAFT_RESPONSE}}

## Contexto del ticket

{{TICKET_CONTEXT}}
