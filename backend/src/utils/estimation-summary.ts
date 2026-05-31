// Helpers para serializar una TicketEstimatedResolution a markdown legible
// que se anexa al `description` de Jira/ServiceNow o se incluye en una respuesta
// al cliente. Sin formato propietario — markdown plano + headings.

import type { TicketEstimatedResolution } from "./estimation";

const CONF_LABEL = { LOW: "Baja", MEDIUM: "Media", HIGH: "Alta" } as const;
const COMPLEX_LABEL = {
  VERY_LOW: "Muy baja", LOW: "Baja", MEDIUM: "Media",
  HIGH: "Alta", VERY_HIGH: "Muy alta", UNKNOWN: "Desconocida",
} as const;

/**
 * Renderiza la estimación como bloque markdown para anexar a una description.
 * Compacto y legible — apto para Jira ADF (texto plano), ServiceNow (HTML/plain) y email.
 */
export function renderEstimateMarkdown(est: TicketEstimatedResolution): string {
  const lines: string[] = [];
  lines.push("## Estimación AMS (auto-generada)");
  lines.push("");
  lines.push(`- **Esfuerzo:** ${est.totalMinHours}–${est.totalMaxHours} h (${est.totalMinBusinessDays}–${est.totalMaxBusinessDays} días hábiles)`);
  lines.push(`- **Confianza:** ${CONF_LABEL[est.confidence]} (${est.confidenceScore}/100)`);
  lines.push(`- **Complejidad:** ${COMPLEX_LABEL[est.complexity]}`);
  lines.push(`- **SLA sugerido:** ${Math.round(est.suggestedSlaMinutes / 60)} h`);
  if (est.manuallyAdjusted) {
    lines.push(`- **Ajuste manual:** sí — ${est.adjustmentReason || "(sin razón)"} (por ${est.adjustedBy || "—"})`);
  }
  lines.push("");

  if (est.phaseBreakdown.length > 0) {
    lines.push("### Fases principales");
    for (const [i, p] of est.phaseBreakdown.slice(0, 8).entries()) {
      lines.push(`${i + 1}. **${p.name}** · ${p.minHours}–${p.maxHours} h · ${p.ownerProfile}`);
    }
    if (est.phaseBreakdown.length > 8) {
      lines.push(`…y ${est.phaseBreakdown.length - 8} fases más.`);
    }
    lines.push("");
  }

  if (est.risks.length > 0) {
    lines.push("### Riesgos");
    for (const r of est.risks) lines.push(`- ${r}`);
    lines.push("");
  }
  if (est.missingData.length > 0) {
    lines.push("### Datos requeridos para precisar");
    for (const m of est.missingData) lines.push(`- ${m}`);
    lines.push("");
  }
  lines.push("---");
  lines.push("_Estimación determinística por el motor AMS. Por rangos — no son tiempos exactos comprometidos._");
  return lines.join("\n");
}

/**
 * Anexa el bloque al final de una description existente sin pisarla.
 * Si la description ya contiene "## Estimación AMS" la reemplaza (evita duplicar
 * cuando se reenvía el mismo ticket).
 */
export function appendEstimateToDescription(
  description: string,
  estimate: TicketEstimatedResolution | null | undefined,
): string {
  if (!estimate) return description;
  const block = renderEstimateMarkdown(estimate);
  const marker = "## Estimación AMS (auto-generada)";
  const idx = description.indexOf(marker);
  if (idx >= 0) {
    return description.slice(0, idx).trimEnd() + "\n\n" + block;
  }
  return description.trimEnd() + "\n\n" + block;
}
