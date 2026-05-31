// Metadatos del agente y la base de conocimiento.
// Se incluyen en cada respuesta del agente para que el frontend pueda
// mostrar trazabilidad (versión, fuentes, modo demo/real).

import { query } from "../database/db";

let cachedAgentVersion: string | null = null;
let cachedKbVersion: { value: string; expiresAt: number } | null = null;
const KB_VERSION_TTL_MS = 60_000; // 1 min

export function getAgentVersion(): string {
  if (cachedAgentVersion) return cachedAgentVersion;
  // Permite override por env (CI/CD pisa con el git sha).
  const env = process.env.AMS_AGENT_VERSION;
  if (env) {
    cachedAgentVersion = env;
    return env;
  }
  try {
    // Lectura perezosa del package.json del backend.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../package.json") as { version?: string };
    cachedAgentVersion = `v${pkg.version || "0.0.0"}`;
  } catch {
    cachedAgentVersion = "v0.0.0";
  }
  return cachedAgentVersion;
}

/**
 * Versión de la base de conocimiento — derivada del max(updated_at) de
 * la tabla agent_knowledge si existe, o de la fecha actual como fallback.
 * Cacheado 1 min para no consultar en cada request.
 */
export async function getKnowledgeBaseVersion(): Promise<string> {
  const now = Date.now();
  if (cachedKbVersion && cachedKbVersion.expiresAt > now) {
    return cachedKbVersion.value;
  }
  let value = `KB-${new Date().toISOString().slice(0, 10)}`;
  try {
    const r = await query<{ max_ts: string | null; n: string }>(
      `SELECT to_char(MAX(updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD-HH24MI') AS max_ts,
              COUNT(*)::text AS n
         FROM agent_knowledge`
    );
    const stamp = r.rows[0]?.max_ts;
    const n = r.rows[0]?.n ?? "0";
    if (stamp) value = `KB-${stamp}-n${n}`;
  } catch {
    // Tabla no existe todavía; usar fallback de fecha
  }
  cachedKbVersion = { value, expiresAt: now + KB_VERSION_TTL_MS };
  return value;
}

/**
 * Modo de operación: demo cuando no hay conectores externos configurados.
 * Real cuando al menos uno de los conectores reales está activo.
 */
export function getOperationMode(): "demo" | "real" {
  const hasJira = process.env.JIRA_ENABLED === "true" && !!process.env.JIRA_API_TOKEN;
  const hasSn = process.env.SERVICENOW_ENABLED === "true" && !!process.env.SERVICENOW_TOKEN;
  const hasSap = process.env.SAP_READONLY_ENABLED === "true" && !!process.env.SAP_BASE_URL;
  return (hasJira || hasSn || hasSap) ? "real" : "demo";
}

/**
 * Construye el objeto `metadata` enriquecido para una respuesta del agente.
 * Pensado para incluirse en la response JSON que ve el frontend.
 */
export interface AgentMetadataInput {
  model: string;
  confidence: string;
  timestamp: string;
  responseId?: string;
  ragSources?: Array<{ documentId: string; sourceFile?: string; chunkIndex?: number; score: number }>;
}

export async function buildAgentMetadata(input: AgentMetadataInput) {
  const agentVersion = getAgentVersion();
  const kbVersion = await getKnowledgeBaseVersion();
  const mode = getOperationMode();
  const sources = (input.ragSources || []).map((s) => ({
    id: s.documentId,
    sourceType: "rag_document" as const,
    title: s.sourceFile || s.documentId,
    chunkIndex: s.chunkIndex,
    relevance: s.score,
  }));
  return {
    model: input.model,
    timestamp: input.timestamp,
    confidence: input.confidence,
    agentVersion,
    kbVersion,
    mode,
    responseId: input.responseId,
    sources,
  };
}
