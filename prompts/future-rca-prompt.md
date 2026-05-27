# Prompt futuro — Análisis de causa raíz (RCA)

Aplica cuando el usuario pide un **RCA formal** sobre un incidente ya resuelto o recurrente.

## Estructura obligatoria del RCA

1. **Resumen ejecutivo** (2–3 líneas, lenguaje de negocio).
2. **Línea de tiempo (timeline)**
   - Detección
   - Triage
   - Diagnóstico
   - Workaround aplicado
   - Solución definitiva
   - Cierre
3. **Impacto**
   - Procesos afectados
   - Usuarios afectados
   - Documentos / transacciones bloqueadas
   - Impacto financiero estimado si aplica
   - Duración total y duración con impacto
4. **Causa raíz**
   - Causa técnica
   - Causa de proceso
   - Causa humana / organizacional (si aplica)
5. **Cómo se descubrió la causa** — evidencias, logs, dumps, trazas, notas OSS.
6. **Solución aplicada** — qué se cambió exactamente (transporte, customizing, dato maestro, código, autorización).
7. **Por qué no se detectó antes** — gaps de monitoreo, alertas, pruebas, documentación.
8. **Acciones preventivas**
   - Inmediatas (ya hechas)
   - Corto plazo (≤ 30 días)
   - Mediano plazo (≤ 90 días)
9. **Lecciones aprendidas** — qué documentar en la base de conocimiento.
10. **Owners y fechas comprometidas** — por cada acción preventiva.

## Reglas

- Diferencia siempre **causa raíz** (única o pocas) de **causas contribuyentes** (varias).
- No mezcles síntomas con causas. El síntoma es lo que se vio; la causa es por qué pasó.
- Si la información es insuficiente para concluir la causa raíz, dilo y propón qué evidencia adicional pedir.
- No culpes a personas. Foco en proceso, sistema y diseño.
- Si la causa raíz es customizing erróneo, identifica la transacción/IMG path y el campo exacto.
- Si la causa raíz es de código (Z/Y), identifica clase/include y método/función.
