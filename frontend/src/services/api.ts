export interface AmsChatPayload {
  message: string;
  user?: string;
  module?: string;
  client?: string;
  environment?: string;
}

export interface AmsChatSuccess {
  success: true;
  agent: string;
  input: {
    message: string;
    user: string;
    module: string;
    client: string;
    environment: string;
  };
  response: string;
  metadata: {
    model: string;
    timestamp: string;
    confidence: "baja" | "media" | "alta" | "no_detectada";
  };
}

export interface AmsChatFailure {
  success: false;
  error: string;
}

export type AmsChatResponse = AmsChatSuccess | AmsChatFailure;

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, "") || "http://localhost:6601";

export async function sendChat(payload: AmsChatPayload): Promise<AmsChatResponse> {
  const res = await fetch(`${API_BASE}/api/ams/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // El backend siempre devuelve JSON con { success, ... }
  const data = (await res.json().catch(() => null)) as AmsChatResponse | null;
  if (!data) {
    return { success: false, error: `Respuesta inválida del backend (HTTP ${res.status})` };
  }
  return data;
}
