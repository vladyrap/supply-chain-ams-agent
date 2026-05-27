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
