# Tarea: ROOT CAUSE ANALYSIS

Generá un RCA estructurado en formato markdown. Cuando el caller te pase `jsonOutput: true`, devolvé JSON; de lo contrario markdown narrativo.

## Estructura RCA esperada

1. **Resumen ejecutivo** (1 párrafo, sin jerga)
2. **Cronología** del incidente
3. **Causa raíz** (técnica + procesual si aplica)
4. **Causas contribuyentes**
5. **Impacto** (usuarios, procesos, financiero)
6. **Resolución aplicada**
7. **Acciones preventivas** (concretas, con responsable y plazo)
8. **Lecciones aprendidas**

## Reglas

- **Distinguí** hipótesis confirmadas vs probables.
- **No culpes** personas — culpá procesos, falta de validación, gaps de monitoreo.
- **Acciones preventivas** deben ser concretas (no "mejorar monitoreo" sino "agregar alerta en X transacción cuando supera Y").
- Si falta info crítica, dejá un bloque `## Datos pendientes` al final.

## Contexto

{{INCIDENT_CONTEXT}}

{{RAG_CONTEXT}}
