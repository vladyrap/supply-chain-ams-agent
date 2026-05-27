"use client";

import { useState } from "react";
import { sendChat, type AmsChatResponse } from "../services/api";

const MODULES = [
  "NO_INFORMADO", "MM", "SD", "PP", "WM", "EWM",
  "QM", "PM", "ARIBA", "IBP", "BTP", "INTEGRACION",
] as const;

const ENVIRONMENTS = ["NO_INFORMADO", "DEV", "QA", "PRD", "SANDBOX"] as const;

interface Props {
  onResult: (r: AmsChatResponse) => void;
  onLoadingChange: (loading: boolean) => void;
}

export default function ChatForm({ onResult, onLoadingChange }: Props) {
  const [message, setMessage] = useState("");
  const [user, setUser] = useState("");
  const [client, setClient] = useState("");
  const [module, setModule] = useState<(typeof MODULES)[number]>("NO_INFORMADO");
  const [environment, setEnvironment] = useState<(typeof ENVIRONMENTS)[number]>("NO_INFORMADO");
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!message.trim()) {
      setLocalError("Describe el incidente o pregunta antes de enviar.");
      return;
    }
    setLoading(true);
    onLoadingChange(true);
    try {
      const res = await sendChat({
        message: message.trim(),
        user: user.trim() || undefined,
        client: client.trim() || undefined,
        module,
        environment,
      });
      onResult(res);
    } catch (err) {
      onResult({
        success: false,
        error: err instanceof Error ? err.message : "Error de red al contactar el backend",
      });
    } finally {
      setLoading(false);
      onLoadingChange(false);
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <div style={{ marginBottom: 14 }}>
        <label htmlFor="message">Incidente o pregunta</label>
        <textarea
          id="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ej: No puedo contabilizar una entrada de mercancía contra una orden de compra."
          maxLength={8000}
          disabled={loading}
        />
      </div>

      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div>
          <label htmlFor="user">Usuario</label>
          <input
            id="user"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="consultor_ams"
            disabled={loading}
          />
        </div>
        <div>
          <label htmlFor="client">Cliente</label>
          <input
            id="client"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            placeholder="demo"
            disabled={loading}
          />
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div>
          <label htmlFor="module">Módulo SAP</label>
          <select
            id="module"
            value={module}
            onChange={(e) => setModule(e.target.value as (typeof MODULES)[number])}
            disabled={loading}
          >
            {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="env">Ambiente</label>
          <select
            id="env"
            value={environment}
            onChange={(e) => setEnvironment(e.target.value as (typeof ENVIRONMENTS)[number])}
            disabled={loading}
          >
            {ENVIRONMENTS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      {localError && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          {localError}
        </div>
      )}

      <div className="row-actions">
        <button type="submit" className="primary" disabled={loading}>
          {loading ? <><span className="spinner" />Procesando…</> : "Enviar al agente"}
        </button>
      </div>
    </form>
  );
}
