import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
  name: "ams_http_requests_total",
  help: "Total HTTP requests al backend AMS",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: "ams_http_request_duration_seconds",
  help: "Duración de requests al backend AMS",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const claudeRequestsTotal = new client.Counter({
  name: "ams_claude_requests_total",
  help: "Llamadas a Claude API",
  labelNames: ["model", "result"] as const,
  registers: [registry],
});

// =============================================================================
// Gemini Governance v0.13 — métricas específicas
// =============================================================================

export const geminiCallsTotal = new client.Counter({
  name: "ams_gemini_calls_total",
  help: "Llamadas estructuradas a Gemini por taskType y resultado",
  labelNames: ["task_type", "model", "result"] as const,
  registers: [registry],
});

export const geminiJsonInvalidTotal = new client.Counter({
  name: "ams_gemini_json_invalid_total",
  help: "Veces que Gemini devolvió JSON que no parseó (antes de reparación)",
  labelNames: ["task_type"] as const,
  registers: [registry],
});

export const geminiRepairAttemptsTotal = new client.Counter({
  name: "ams_gemini_repair_attempts_total",
  help: "Reintentos de reparación de JSON Gemini",
  labelNames: ["task_type", "outcome"] as const, // outcome: success | failed
  registers: [registry],
});

export const geminiTimeoutTotal = new client.Counter({
  name: "ams_gemini_timeout_total",
  help: "Timeouts en llamadas a Gemini",
  labelNames: ["task_type"] as const,
  registers: [registry],
});

export const geminiFallbackUsedTotal = new client.Counter({
  name: "ams_gemini_fallback_used_total",
  help: "Veces que se cayó al engine determinístico tras fallo Gemini",
  labelNames: ["task_type", "reason"] as const,
  registers: [registry],
});

export const geminiCallDuration = new client.Histogram({
  name: "ams_gemini_call_duration_seconds",
  help: "Duración de llamadas Gemini estructuradas",
  labelNames: ["task_type", "model"] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});

export const geminiConfidenceLevel = new client.Counter({
  name: "ams_gemini_confidence_level_total",
  help: "Distribución de niveles de confianza reportados por Gemini",
  labelNames: ["task_type", "level"] as const, // level: alta | media | baja
  registers: [registry],
});
