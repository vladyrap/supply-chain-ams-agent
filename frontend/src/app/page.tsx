"use client";

import { useState } from "react";
import ChatForm from "../components/ChatForm";
import ResponseView from "../components/ResponseView";
import type { AmsChatResponse } from "../services/api";

export default function HomePage() {
  const [result, setResult] = useState<AmsChatResponse | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <main className="container">
      <header className="header">
        <h1>Agente AMS Supply Chain</h1>
        <p className="subtitle">
          Diagnóstico inicial, clasificación y paso a paso para incidentes SAP Supply Chain.
        </p>
      </header>

      <div className="alert alert-warn" style={{ marginBottom: 18 }}>
        El agente no ejecuta cambios reales en SAP. Toda recomendación debe validarse en
        DEV/QA antes de productivo y requiere aprobación humana.
      </div>

      <ChatForm onResult={setResult} onLoadingChange={setLoading} />

      <ResponseView result={result} loading={loading} />

      <footer className="foot">
        supply-chain-ams-agent · Fase 1 · solo diagnóstico, sin conexión SAP
      </footer>
    </main>
  );
}
