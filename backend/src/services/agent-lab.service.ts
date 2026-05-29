// Agent Lab — laboratorio de mejora del agente.
//
// Dos features:
//  1) Wizard ticket → KB: toma un ticket resuelto + su conversación y le pide
//     a Gemini que extraiga un artículo curado (problema / solución / tags).
//     Solo es un DRAFT — el humano edita y aprueba antes de guardar en kb_articles.
//
//  2) Prompt Playground: ejecuta una query contra Gemini con un system prompt
//     custom y devuelve respuesta + latencia + tokens. Útil para probar
//     variantes del prompt sin afectar producción.

import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { ConfigError, ClaudeError } from "../utils/errors";
import { extractUsage } from "./usage.service";

const DEFAULT_MODEL = "gemini-2.5-flash";

let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ConfigError("GEMINI_API_KEY no configurada");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

// ============================================================================
// WIZARD TICKET → KB
// ============================================================================
export interface ResolvedTicketSummary {
  id: string;
  code: string;
  title: string;
  summary: string;
  status: string;
  priority: string;
  conversation_id: string | null;
  resolved_at: string | null;
  has_kb: boolean;
  client: string | null;
  sap_module: string | null;
}

/** Lista tickets resueltos o cerrados (candidatos para convertir en KB) */
export async function listConvertibleTickets(limit = 50): Promise<ResolvedTicketSummary[]> {
  const { rows } = await query<ResolvedTicketSummary>(
    `SELECT
       t.id, t.code, t.title, t.summary, t.status, t.priority,
       t.conversation_id, t.resolved_at, t.client, t.sap_module,
       (t.kb_article_id IS NOT NULL) AS has_kb
     FROM support_tickets t
     WHERE t.status IN ('resolved','closed')
     ORDER BY (t.kb_article_id IS NOT NULL) ASC, t.resolved_at DESC NULLS LAST, t.created_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(200, limit))]
  );
  return rows;
}

export interface KbDraft {
  title: string;
  problem: string;
  solution: string;
  category: string | null;
  system: string | null;
  tags: string[];
  /** Resumen breve del contexto que se usó */
  sourceSummary: string;
}

export interface DraftFromTicketResult {
  draft: KbDraft;
  ticket: {
    id: string; code: string; title: string; summary: string; client: string | null;
    sap_module: string | null; priority: string;
  };
  conversationMessages: number;
  model: string;
  latencyMs: number;
  tokens: { prompt: number; completion: number; total: number };
}

/**
 * Lee el ticket + su conversación + los mensajes y pide a Gemini un draft
 * estructurado en JSON. Si Gemini devuelve algo no parseable, hacemos best-effort.
 */
export async function draftKbFromTicket(ticketId: string): Promise<DraftFromTicketResult> {
  const { rows: tk } = await query<{
    id: string; code: string; title: string; summary: string; client: string | null;
    sap_module: string | null; priority: string; conversation_id: string | null;
  }>(
    `SELECT id, code, title, summary, client, sap_module, priority, conversation_id
     FROM support_tickets WHERE id = $1 LIMIT 1`,
    [ticketId]
  );
  if (tk.length === 0) throw new ClaudeError(`Ticket ${ticketId} no encontrado`);
  const ticket = tk[0];

  // Mensajes de la conversación origen (si existen)
  let messages: { role: string; text: string }[] = [];
  if (ticket.conversation_id) {
    const { rows } = await query<{ role: string; text: string }>(
      `SELECT role, COALESCE(text,'') AS text
       FROM support_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT 60`,
      [ticket.conversation_id]
    );
    messages = rows;
  }

  const transcript = messages.length
    ? messages.map((m) => `[${m.role.toUpperCase()}] ${m.text}`).join("\n").slice(0, 8000)
    : "(sin conversación asociada — usar título y resumen del ticket)";

  const userPrompt = `
Tienes que extraer un artículo curado de KB a partir del ticket y su conversación.

# TICKET
- Código: ${ticket.code}
- Título: ${ticket.title}
- Resumen: ${ticket.summary || "(sin resumen)"}
- Módulo SAP: ${ticket.sap_module || "no informado"}
- Prioridad: ${ticket.priority}
- Cliente: ${ticket.client || "—"}

# TRANSCRIPCIÓN
${transcript}

# INSTRUCCIONES
Devuelve SOLO un JSON válido sin markdown, con esta forma:
{
  "title": "Título breve del artículo (máx 80 chars, claro y accionable)",
  "problem": "Descripción del problema en 2-4 oraciones, sin nombres propios ni datos sensibles",
  "solution": "Paso a paso en markdown con numeración o bullets. Incluye transacciones SAP, queries y comandos específicos cuando sea posible.",
  "category": "operativo | configuración | data | autorizaciones | performance | otro",
  "system": "SD | MM | PP | FI | CO | EWM | TM | LE-TRA | no_informado",
  "tags": ["tag1","tag2","tag3"],
  "sourceSummary": "Una oración con el contexto: por qué se creó este artículo."
}

Reglas:
- No incluyas \`\`\`json ni comentarios — SOLO JSON.
- Si la conversación no tiene solución clara, propón los pasos típicos para esa categoría.
- "tags" entre 2 y 5 palabras clave.
- "title" en español, corto y específico.
`.trim();

  const ai = getClient();
  const start = Date.now();
  let resp;
  try {
    resp = await ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: "Eres un curador de base de conocimiento AMS Supply Chain SAP. Respondes SOLO JSON.",
        responseMimeType: "application/json",
        maxOutputTokens: 2048,
        temperature: 0.2,
      },
    });
  } catch (err) {
    logger.error({ err }, "wizard.draft fail (Gemini)");
    throw new ClaudeError("Error llamando a Gemini para draft de KB", err);
  }
  const latencyMs = Date.now() - start;
  const usageRaw = extractUsage(resp);
  const usage = { prompt: usageRaw.promptTokens, completion: usageRaw.completionTokens, total: usageRaw.totalTokens };
  const text = (resp.text ?? "").trim();

  // Parse best-effort
  let parsed: Partial<KbDraft> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // intentar quitar fences si Gemini los puso
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { /* dejar parsed vacío */ }
    }
  }

  const draft: KbDraft = {
    title: typeof parsed.title === "string" ? parsed.title.slice(0, 200) : ticket.title,
    problem: typeof parsed.problem === "string" ? parsed.problem : (ticket.summary || ""),
    solution: typeof parsed.solution === "string" ? parsed.solution : "Solución pendiente — completar manualmente.",
    category: typeof parsed.category === "string" ? parsed.category : null,
    system: typeof parsed.system === "string" ? parsed.system : (ticket.sap_module || null),
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t) => typeof t === "string").slice(0, 6) : [],
    sourceSummary: typeof parsed.sourceSummary === "string" ? parsed.sourceSummary : `Generado desde ${ticket.code}`,
  };

  return {
    draft,
    ticket: {
      id: ticket.id, code: ticket.code, title: ticket.title, summary: ticket.summary,
      client: ticket.client, sap_module: ticket.sap_module, priority: ticket.priority,
    },
    conversationMessages: messages.length,
    model: DEFAULT_MODEL,
    latencyMs,
    tokens: usage,
  };
}

// ============================================================================
// PROMPT PLAYGROUND
// ============================================================================
export interface PlaygroundRunInput {
  systemPrompt: string;
  query: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface PlaygroundRunResult {
  text: string;
  model: string;
  latencyMs: number;
  tokens: { prompt: number; completion: number; total: number };
}

// ============================================================================
// PROMPT VERSIONING — adoptar variante del Playground como activa
// ============================================================================
let promptSchemaEnsured = false;
async function ensurePromptSchema(): Promise<void> {
  if (promptSchemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS agent_prompt_versions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        label           TEXT NOT NULL,
        system_prompt   TEXT NOT NULL,
        temperature     REAL NOT NULL DEFAULT 0.4,
        max_tokens      INTEGER NOT NULL DEFAULT 1024,
        active          BOOLEAN NOT NULL DEFAULT false,
        created_by      TEXT NOT NULL DEFAULT 'sistema',
        adoption_notes  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_agent_prompt_active  ON agent_prompt_versions(active) WHERE active = true;`);
    await query(`CREATE INDEX IF NOT EXISTS idx_agent_prompt_created ON agent_prompt_versions(created_at DESC);`);
    promptSchemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure agent_prompt_versions schema failed");
  }
}

export interface PromptVersionRow {
  id: string;
  label: string;
  system_prompt: string;
  temperature: number;
  max_tokens: number;
  active: boolean;
  created_by: string;
  adoption_notes: string | null;
  created_at: string;
}

export interface AdoptPromptInput {
  label: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number;
  createdBy?: string;
  adoptionNotes?: string;
}

export async function adoptPrompt(input: AdoptPromptInput): Promise<PromptVersionRow> {
  await ensurePromptSchema();
  // desactivar la versión activa actual
  await query(`UPDATE agent_prompt_versions SET active = false WHERE active = true`);
  const { rows } = await query<PromptVersionRow>(
    `INSERT INTO agent_prompt_versions
       (label, system_prompt, temperature, max_tokens, active, created_by, adoption_notes)
     VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING *`,
    [
      input.label.slice(0, 200),
      input.systemPrompt.slice(0, 16000),
      Math.max(0, Math.min(1.5, input.temperature ?? 0.4)),
      Math.max(128, Math.min(4096, input.maxTokens ?? 1024)),
      input.createdBy ?? "sistema",
      input.adoptionNotes ?? null,
    ]
  );
  // Invalidar cache del agente para que la próxima consulta use el nuevo prompt
  try {
    const { invalidateActivePromptCache } = await import("./claude.service");
    invalidateActivePromptCache();
  } catch { /* ignore */ }
  return rows[0]!;
}

export async function getActivePrompt(): Promise<PromptVersionRow | null> {
  await ensurePromptSchema();
  const { rows } = await query<PromptVersionRow>(
    `SELECT * FROM agent_prompt_versions WHERE active = true ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function listPromptVersions(limit = 50): Promise<PromptVersionRow[]> {
  await ensurePromptSchema();
  const { rows } = await query<PromptVersionRow>(
    `SELECT * FROM agent_prompt_versions ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(200, limit))]
  );
  return rows;
}

export async function activatePromptVersion(id: string): Promise<PromptVersionRow | null> {
  await ensurePromptSchema();
  await query(`UPDATE agent_prompt_versions SET active = false WHERE active = true`);
  const { rows } = await query<PromptVersionRow>(
    `UPDATE agent_prompt_versions SET active = true WHERE id = $1 RETURNING *`, [id]
  );
  try {
    const { invalidateActivePromptCache } = await import("./claude.service");
    invalidateActivePromptCache();
  } catch { /* ignore */ }
  return rows[0] ?? null;
}

// ============================================================================
// PROMPT PLAYGROUND
// ============================================================================
export async function runPlayground(input: PlaygroundRunInput): Promise<PlaygroundRunResult> {
  if (!input.systemPrompt?.trim()) throw new ClaudeError("system prompt vacío");
  if (!input.query?.trim()) throw new ClaudeError("query vacía");
  const ai = getClient();
  const start = Date.now();
  let resp;
  try {
    resp = await ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents: input.query.slice(0, 8000),
      config: {
        systemInstruction: input.systemPrompt.slice(0, 16000),
        maxOutputTokens: Math.max(128, Math.min(4096, input.maxOutputTokens ?? 1024)),
        temperature: Math.max(0, Math.min(1.5, input.temperature ?? 0.4)),
      },
    });
  } catch (err) {
    logger.error({ err }, "playground.run fail");
    throw new ClaudeError("Error ejecutando playground", err);
  }
  const latencyMs = Date.now() - start;
  const usageRaw = extractUsage(resp);
  const usage = { prompt: usageRaw.promptTokens, completion: usageRaw.completionTokens, total: usageRaw.totalTokens };
  const text = (resp.text ?? "").trim();
  return { text, model: DEFAULT_MODEL, latencyMs, tokens: usage };
}
