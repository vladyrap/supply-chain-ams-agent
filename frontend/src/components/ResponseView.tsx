"use client";

import type { AmsChatResponse } from "../services/api";

interface Props {
  result: AmsChatResponse | null;
  loading: boolean;
}

function confidenceBadgeClass(c: string) {
  switch (c) {
    case "alta":  return "badge badge-alta";
    case "media": return "badge badge-media";
    case "baja":  return "badge badge-baja";
    default:      return "badge badge-no_detectada";
  }
}

export default function ResponseView({ result, loading }: Props) {
  if (loading && !result) {
    return (
      <div className="card">
        <div className="alert alert-info">
          <span className="spinner" />Consultando al agente AMS…
        </div>
      </div>
    );
  }

  if (!result) return null;

  if (!result.success) {
    return (
      <div className="card">
        <div className="alert alert-error">
          <b>Error:</b> {result.error}
        </div>
      </div>
    );
  }

  const ts = result.metadata.timestamp
    ? new Date(result.metadata.timestamp).toLocaleString()
    : "—";

  return (
    <div className="card">
      <div className="meta" style={{ marginBottom: 14 }}>
        <span><b>Modelo:</b> {result.metadata.model}</span>
        <span><b>Fecha:</b> {ts}</span>
        <span>
          <b>Confianza:</b>{" "}
          <span className={confidenceBadgeClass(result.metadata.confidence)}>
            {result.metadata.confidence}
          </span>
        </span>
        <span><b>Módulo:</b> {result.input.module}</span>
        <span><b>Ambiente:</b> {result.input.environment}</span>
      </div>

      <div className="response">{result.response}</div>
    </div>
  );
}
