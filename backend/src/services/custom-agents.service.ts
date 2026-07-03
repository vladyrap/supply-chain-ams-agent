// =============================================================================
// custom-agents.service.ts — v1.3 Agent Hub
// =============================================================================
// Agentes creados por el usuario (estilo IBM Consulting Advantage):
//   - Cada agente tiene nombre, categoría (módulo SAP o funcional), descripción,
//     instrucciones (system prompt en lenguaje natural) y visibilidad.
//   - "Verified" = agentes de fábrica (los 8 especialistas SAP) — no editables.
//   - El chat de un agente reusa chatWithAgent() con systemPromptOverride,
//     por lo que hereda RAG per-tenant + few-shot + rate limiting Gemini.
// =============================================================================

import { query } from "../database/db";
import { chatWithAgent, type ClaudeChatResult } from "./claude.service";
import { logger } from "../utils/logger";

export interface CustomAgent {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  description: string;
  instructions: string;
  kbModules: string[];
  icon: string;
  /** Modelo LLM del agente — de ALLOWED_AGENT_MODELS (Gemini o Claude). */
  model: string;
  /** private = borrador (solo el creador lo ve) · team = publicado al equipo · public = sistema */
  visibility: "private" | "team" | "public";
  isVerified: boolean;
  status: "active" | "archived";
  rating: number;
  ratingCount: number;
  chatCount: number;
  createdBy: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  category: string;
  description?: string;
  instructions: string;
  kbModules?: string[];
  icon?: string;
  model?: string;
  visibility?: "private" | "team" | "public";
  createdBy?: string | null;
}

export const AGENT_CATEGORIES = [
  "MM", "SD", "PP", "FI", "CO", "BTP", "EWM", "INTEGRACION",
  "PRODUCTIVIDAD", "REPORTING", "GENERAL",
] as const;

// Modelos disponibles para agentes custom (onda 4.1).
// Los claude-* requieren ANTHROPIC_API_KEY en el backend.
export const DEFAULT_AGENT_MODEL = "gemini-2.5-flash";
export const ALLOWED_AGENT_MODELS = [
  "gemini-2.5-flash",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "claude-opus-4-8",
] as const;

function normalizeModel(model: string | undefined): string {
  const m = (model ?? "").trim();
  if (!m) return DEFAULT_AGENT_MODEL;
  if (!(ALLOWED_AGENT_MODELS as readonly string[]).includes(m)) {
    throw new Error(
      `Modelo "${m}" no permitido. Opciones: ${ALLOWED_AGENT_MODELS.join(", ")}`,
    );
  }
  return m;
}

// ============================================================
// Schema
// ============================================================

let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS custom_agents (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      name         TEXT NOT NULL,
      category     TEXT NOT NULL DEFAULT 'GENERAL',
      description  TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      kb_modules   TEXT[] NOT NULL DEFAULT '{}',
      icon         TEXT NOT NULL DEFAULT '🤖',
      visibility   TEXT NOT NULL DEFAULT 'private',
      is_verified  BOOLEAN NOT NULL DEFAULT false,
      status       TEXT NOT NULL DEFAULT 'active',
      rating       NUMERIC(3,2) NOT NULL DEFAULT 0,
      rating_count INTEGER NOT NULL DEFAULT 0,
      chat_count   INTEGER NOT NULL DEFAULT 0,
      created_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_custom_agents_tenant ON custom_agents(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_custom_agents_category ON custom_agents(tenant_id, category)`);
  // Onda 4 — publicación al equipo
  await query(`ALTER TABLE custom_agents ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`);
  await query(`ALTER TABLE custom_agents ADD COLUMN IF NOT EXISTS published_by TEXT`);
  // Onda 4.1 — modelo LLM por agente (Gemini default; claude-* vía Anthropic)
  await query(`ALTER TABLE custom_agents ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'gemini-2.5-flash'`);
  // Onda 5 — historial de versiones (snapshot en cada guardado del builder)
  await query(`
    CREATE TABLE IF NOT EXISTS custom_agent_versions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      agent_id     UUID NOT NULL,
      name         TEXT NOT NULL,
      category     TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL,
      kb_modules   TEXT[] NOT NULL DEFAULT '{}',
      icon         TEXT NOT NULL DEFAULT '🤖',
      model        TEXT NOT NULL DEFAULT 'gemini-2.5-flash',
      saved_by     TEXT,
      saved_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_versions ON custom_agent_versions(tenant_id, agent_id, saved_at DESC)`);
  schemaEnsured = true;
}

// ============================================================
// Seed — 8 especialistas SAP como agentes verified de fábrica
// ============================================================

const VERIFIED_SEED: Array<Omit<CreateAgentInput, "createdBy"> & { icon: string }> = [
  {
    name: "Especialista MM",
    category: "MM",
    icon: "📦",
    description: "Materials Management: compras, recepciones, inventario, verificación de facturas logística.",
    instructions: "Eres un consultor senior SAP MM (Materials Management). Respondes en español con precisión técnica: transacciones exactas (ME21N, MIGO, MIRO, MB1A), tablas relevantes y pasos accionables. Cuando el problema involucra WM/EWM o FI, lo señalas y sugieres al especialista correspondiente. Siempre pides los datos mínimos para diagnosticar: número de documento, centro, mensaje de error exacto.",
    kbModules: ["MM"],
  },
  {
    name: "Especialista SD",
    category: "SD",
    icon: "🛒",
    description: "Sales & Distribution: pedidos de venta, entregas, facturación, determinación de precios.",
    instructions: "Eres un consultor senior SAP SD (Sales & Distribution). Dominas el flujo OTC completo: VA01→VL01N→VF01, determinación de precios (VK11/VK13), determinación de cuentas (VKOA) y esquemas de cálculo. Respondes en español con transacciones y pasos concretos. Si el caso toca FI deudores o crédito, lo indicas explícitamente.",
    kbModules: ["SD"],
  },
  {
    name: "Especialista PP",
    category: "PP",
    icon: "🏭",
    description: "Production Planning: órdenes de producción, MRP, confirmaciones, listas de materiales.",
    instructions: "Eres un consultor senior SAP PP (Production Planning). Dominas órdenes de producción (CO01/CO02), MRP (MD02/MD04), confirmaciones (CO11N/CO13), BOM (CS01-03) y hojas de ruta. Respondes en español, siempre verificando el status de la orden (CRTD/REL/TECO/CLSD) antes de proponer acciones.",
    kbModules: ["PP"],
  },
  {
    name: "Especialista FI",
    category: "FI",
    icon: "💰",
    description: "Finanzas: contabilización, cierre mensual, cuentas por pagar/cobrar, impuestos.",
    instructions: "Eres un consultor senior SAP FI (Financial Accounting). Dominas registro de facturas (FB60/MIRO), pagos (F-53/F110), cierres (OB52, MMPV, FAGLB03), maestros de cuentas (FS00) y determinación automática (OBYC). Respondes en español citando transacción + tabla + paso. Los temas de costos internos los derivas al especialista CO.",
    kbModules: ["FI"],
  },
  {
    name: "Especialista CO",
    category: "CO",
    icon: "📊",
    description: "Controlling: centros de coste, órdenes internas, liquidaciones, planificación.",
    instructions: "Eres un consultor senior SAP CO (Controlling). Dominas centros de coste (KS01-03, KP06), repartos (KSU1/KSU5), órdenes internas (KO01-04, KO88), y análisis plan/real. Respondes en español. Verificas siempre que el período CO esté abierto antes de proponer contabilizaciones.",
    kbModules: ["CO"],
  },
  {
    name: "Especialista BTP / Integraciones",
    category: "BTP",
    icon: "🔗",
    description: "Business Technology Platform: CPI, IAS, API Hub, Cloud Connector, integraciones.",
    instructions: "Eres un consultor senior SAP BTP e integraciones. Dominas CPI (iFlows, adapters, mappings), IAS/SSO, API Hub, Cloud Connector y destinos. Respondes en español con foco en troubleshooting: logs de CPI, trust setup, reachability. Distingues claramente entre problemas de red, de autenticación y de mapping.",
    kbModules: ["BTP", "INTEGRACION"],
  },
  {
    name: "Especialista EWM",
    category: "EWM",
    icon: "🏗️",
    description: "Extended Warehouse Management: warehouse orders, tareas, HU, inventario físico, RF.",
    instructions: "Eres un consultor senior SAP EWM. Dominas warehouse orders/tasks, Handling Units (HU02/HU03), estrategias de putaway/picking (/SCWM/PRR1), monitor (/SCWM/MON) e inventario físico con RF. Respondes en español. Siempre verificas el status de la HU y del warehouse task antes de proponer correcciones.",
    kbModules: ["EWM"],
  },
  {
    name: "Asistente AMS General",
    category: "GENERAL",
    icon: "🤖",
    description: "Triage inicial: clasifica el problema, identifica el módulo y deriva al especialista correcto.",
    instructions: "Eres el asistente AMS de primer nivel. Tu trabajo: (1) entender el problema del usuario, (2) identificar el módulo SAP afectado, (3) pedir la evidencia mínima (transacción, mensaje de error, datos de entrada), (4) buscar solución en la base de conocimiento, y (5) si no puedes resolver con confianza alta, indicar qué especialista debe tomar el caso y con qué información. Respondes en español, claro y accionable.",
    kbModules: [],
  },
];

async function seedVerifiedAgents(tenantId: string): Promise<void> {
  const { rows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM custom_agents WHERE tenant_id = $1 AND is_verified = true`,
    [tenantId],
  );
  if (Number(rows[0]?.c ?? 0) > 0) return;
  for (const a of VERIFIED_SEED) {
    await query(
      `INSERT INTO custom_agents
         (tenant_id, name, category, description, instructions, kb_modules, icon, visibility, is_verified, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'public',true,'system')`,
      [tenantId, a.name, a.category, a.description ?? "", a.instructions, a.kbModules ?? [], a.icon],
    );
  }
  logger.info({ tenantId, count: VERIFIED_SEED.length }, "custom-agents: verified seed OK");
}

async function ready(tenantId: string): Promise<void> {
  await ensureSchema();
  await seedVerifiedAgents(tenantId);
}

// ============================================================
// Mapper
// ============================================================

interface AgentRow {
  id: string;
  tenant_id: string;
  name: string;
  category: string;
  description: string;
  instructions: string;
  kb_modules: string[];
  icon: string;
  model: string;
  visibility: string;
  is_verified: boolean;
  status: string;
  rating: string;
  rating_count: number;
  chat_count: number;
  created_by: string | null;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapAgent(r: AgentRow): CustomAgent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    category: r.category,
    description: r.description,
    instructions: r.instructions,
    kbModules: r.kb_modules ?? [],
    icon: r.icon,
    model: r.model || DEFAULT_AGENT_MODEL,
    visibility: r.visibility as CustomAgent["visibility"],
    isVerified: r.is_verified,
    status: r.status as CustomAgent["status"],
    rating: Number(r.rating),
    ratingCount: r.rating_count,
    chatCount: r.chat_count,
    createdBy: r.created_by,
    publishedAt: r.published_at,
    publishedBy: r.published_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ============================================================
// CRUD
// ============================================================

export async function listAgents(
  tenantId: string,
  filters: {
    category?: string;
    createdBy?: string;
    verifiedOnly?: boolean;
    search?: string;
    /** Usuario que consulta: ve publicados (team/public) + sus propios borradores. Sin forUser → solo publicados. */
    forUser?: string;
  } = {},
): Promise<CustomAgent[]> {
  await ready(tenantId);
  const conds: string[] = [`tenant_id = $1`, `status = 'active'`];
  const params: unknown[] = [tenantId];
  // Publicación: los borradores (visibility='private') solo los ve su creador.
  if (filters.forUser) {
    params.push(filters.forUser);
    conds.push(`(visibility IN ('team','public') OR is_verified = true OR created_by = $${params.length})`);
  } else {
    conds.push(`(visibility IN ('team','public') OR is_verified = true)`);
  }
  if (filters.category) {
    params.push(filters.category);
    conds.push(`category = $${params.length}`);
  }
  if (filters.createdBy) {
    params.push(filters.createdBy);
    conds.push(`created_by = $${params.length}`);
  }
  if (filters.verifiedOnly) conds.push(`is_verified = true`);
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conds.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  const { rows } = await query<AgentRow>(
    `SELECT * FROM custom_agents WHERE ${conds.join(" AND ")}
     ORDER BY is_verified DESC, rating DESC, chat_count DESC, created_at DESC`,
    params,
  );
  return rows.map(mapAgent);
}

export async function getAgent(tenantId: string, id: string): Promise<CustomAgent | null> {
  await ready(tenantId);
  const { rows } = await query<AgentRow>(
    `SELECT * FROM custom_agents WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] ? mapAgent(rows[0]) : null;
}

export const MAX_AGENTS_PER_TENANT = 50;
export const MAX_INSTRUCTIONS_LENGTH = 6000;

export async function createAgent(tenantId: string, input: CreateAgentInput): Promise<CustomAgent> {
  await ready(tenantId);
  if (!input.name?.trim()) throw new Error("name es obligatorio");
  if (!input.instructions?.trim()) throw new Error("instructions es obligatorio");
  if (input.instructions.length > MAX_INSTRUCTIONS_LENGTH) {
    throw new Error(`Las instrucciones superan ${MAX_INSTRUCTIONS_LENGTH} caracteres`);
  }
  // Límite anti-abuso: agentes activos por tenant
  const { rows: cnt } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM custom_agents WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  );
  if (Number(cnt[0]?.c ?? 0) >= MAX_AGENTS_PER_TENANT) {
    throw new Error(`Límite de ${MAX_AGENTS_PER_TENANT} agentes por tenant alcanzado. Archivá alguno primero.`);
  }
  const { rows } = await query<AgentRow>(
    `INSERT INTO custom_agents
       (tenant_id, name, category, description, instructions, kb_modules, icon, model, visibility, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      tenantId,
      input.name.trim(),
      input.category || "GENERAL",
      input.description?.trim() ?? "",
      input.instructions.trim(),
      input.kbModules ?? [],
      input.icon || "🤖",
      normalizeModel(input.model),
      input.visibility ?? "private",
      input.createdBy ?? null,
    ],
  );
  return mapAgent(rows[0]!);
}

// Onda 5 — snapshot del estado actual antes de un update relevante.
// Mantiene las últimas 20 versiones por agente.
const MAX_VERSIONS_PER_AGENT = 20;

async function snapshotVersion(tenantId: string, agent: CustomAgent, savedBy?: string | null): Promise<void> {
  await query(
    `INSERT INTO custom_agent_versions
       (tenant_id, agent_id, name, category, description, instructions, kb_modules, icon, model, saved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      tenantId, agent.id, agent.name, agent.category, agent.description,
      agent.instructions, agent.kbModules, agent.icon, agent.model, savedBy ?? null,
    ],
  );
  await query(
    `DELETE FROM custom_agent_versions
      WHERE agent_id = $1 AND tenant_id = $2
        AND id NOT IN (
          SELECT id FROM custom_agent_versions
           WHERE agent_id = $1 AND tenant_id = $2
           ORDER BY saved_at DESC LIMIT ${MAX_VERSIONS_PER_AGENT}
        )`,
    [agent.id, tenantId],
  );
}

export async function updateAgent(
  tenantId: string,
  id: string,
  input: Partial<CreateAgentInput> & { status?: "active" | "archived" },
): Promise<CustomAgent | null> {
  await ready(tenantId);
  const existing = await getAgent(tenantId, id);
  if (!existing) return null;
  if (existing.isVerified) throw new Error("Los agentes verificados del sistema no se pueden editar");

  // Onda 5 — si cambia el contenido del agente, snapshot del estado previo
  const contentKeys: Array<keyof CreateAgentInput> = [
    "name", "category", "description", "instructions", "kbModules", "icon", "model",
  ];
  if (contentKeys.some((k) => input[k] !== undefined)) {
    await snapshotVersion(tenantId, existing, input.createdBy ?? existing.createdBy).catch((err) =>
      logger.debug({ err }, "snapshot version fail (non-blocking)"));
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.name !== undefined) push("name", input.name.trim());
  if (input.category !== undefined) push("category", input.category);
  if (input.description !== undefined) push("description", input.description.trim());
  if (input.instructions !== undefined) push("instructions", input.instructions.trim());
  if (input.kbModules !== undefined) push("kb_modules", input.kbModules);
  if (input.icon !== undefined) push("icon", input.icon);
  if (input.model !== undefined) push("model", normalizeModel(input.model));
  if (input.visibility !== undefined) push("visibility", input.visibility);
  if (input.status !== undefined) push("status", input.status);
  if (sets.length === 0) return existing;
  sets.push(`updated_at = now()`);

  params.push(id);
  const idIdx = params.length;
  params.push(tenantId);
  const tenantIdx = params.length;
  const { rows } = await query<AgentRow>(
    `UPDATE custom_agents SET ${sets.join(", ")} WHERE id = $${idIdx} AND tenant_id = $${tenantIdx} RETURNING *`,
    params,
  );
  return rows[0] ? mapAgent(rows[0]) : null;
}

export async function deleteAgent(tenantId: string, id: string): Promise<boolean> {
  await ready(tenantId);
  const existing = await getAgent(tenantId, id);
  if (!existing) return false;
  if (existing.isVerified) throw new Error("Los agentes verificados del sistema no se pueden eliminar");
  await query(`DELETE FROM custom_agents WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return true;
}

// ============================================================
// Publicación (onda 4) — borrador privado → publicado al equipo
// ============================================================

export async function publishAgent(
  tenantId: string,
  id: string,
  user: string,
): Promise<CustomAgent> {
  await ready(tenantId);
  const existing = await getAgent(tenantId, id);
  if (!existing) throw new Error("Agente no encontrado");
  if (existing.isVerified) throw new Error("Los agentes verificados del sistema ya son públicos");
  if (existing.createdBy && existing.createdBy !== user) {
    throw new Error("Solo el creador puede publicar este agente");
  }
  if (!existing.instructions?.trim() || existing.instructions.trim().length < 30) {
    throw new Error("El agente necesita instrucciones (mínimo 30 caracteres) antes de publicarse");
  }
  if (!existing.description?.trim()) {
    throw new Error("Agregá una descripción corta antes de publicar: es lo que ve el equipo en la biblioteca");
  }
  const { rows } = await query<AgentRow>(
    `UPDATE custom_agents
        SET visibility = 'team', published_at = now(), published_by = $3, updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId, user],
  );
  return mapAgent(rows[0]!);
}

export async function unpublishAgent(
  tenantId: string,
  id: string,
  user: string,
): Promise<CustomAgent> {
  await ready(tenantId);
  const existing = await getAgent(tenantId, id);
  if (!existing) throw new Error("Agente no encontrado");
  if (existing.isVerified) throw new Error("Los agentes verificados del sistema no se pueden despublicar");
  if (existing.createdBy && existing.createdBy !== user) {
    throw new Error("Solo el creador puede despublicar este agente");
  }
  const { rows } = await query<AgentRow>(
    `UPDATE custom_agents
        SET visibility = 'private', published_at = NULL, published_by = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId],
  );
  return mapAgent(rows[0]!);
}

// ============================================================
// Onda 5 — historial de versiones
// ============================================================

export interface AgentVersion {
  id: string;
  agentId: string;
  name: string;
  category: string;
  description: string;
  instructions: string;
  kbModules: string[];
  icon: string;
  model: string;
  savedBy: string | null;
  savedAt: string;
}

interface VersionRow {
  id: string;
  agent_id: string;
  name: string;
  category: string;
  description: string;
  instructions: string;
  kb_modules: string[];
  icon: string;
  model: string;
  saved_by: string | null;
  saved_at: string;
}

function mapVersion(r: VersionRow): AgentVersion {
  return {
    id: r.id, agentId: r.agent_id, name: r.name, category: r.category,
    description: r.description, instructions: r.instructions,
    kbModules: r.kb_modules ?? [], icon: r.icon, model: r.model,
    savedBy: r.saved_by, savedAt: r.saved_at,
  };
}

export async function listVersions(tenantId: string, agentId: string): Promise<AgentVersion[]> {
  await ready(tenantId);
  const { rows } = await query<VersionRow>(
    `SELECT * FROM custom_agent_versions
      WHERE agent_id = $1 AND tenant_id = $2
      ORDER BY saved_at DESC`,
    [agentId, tenantId],
  );
  return rows.map(mapVersion);
}

export async function restoreVersion(
  tenantId: string,
  agentId: string,
  versionId: string,
  user: string,
): Promise<CustomAgent> {
  await ready(tenantId);
  const agent = await getAgent(tenantId, agentId);
  if (!agent) throw new Error("Agente no encontrado");
  if (agent.isVerified) throw new Error("Los agentes verificados del sistema no se pueden editar");
  if (agent.createdBy && agent.createdBy !== user) {
    throw new Error("Solo el creador puede restaurar versiones de este agente");
  }
  const { rows } = await query<VersionRow>(
    `SELECT * FROM custom_agent_versions WHERE id = $1 AND agent_id = $2 AND tenant_id = $3`,
    [versionId, agentId, tenantId],
  );
  if (!rows[0]) throw new Error("Versión no encontrada");
  const v = mapVersion(rows[0]);
  // El estado actual también se snapshotea, así el restore es deshacible
  await snapshotVersion(tenantId, agent, user).catch(() => null);
  const { rows: updated } = await query<AgentRow>(
    `UPDATE custom_agents
        SET name = $3, category = $4, description = $5, instructions = $6,
            kb_modules = $7, icon = $8, model = $9, updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [agentId, tenantId, v.name, v.category, v.description, v.instructions, v.kbModules, v.icon, v.model],
  );
  return mapAgent(updated[0]!);
}

// ============================================================
// Onda 5 — duplicar agente (cualquiera visible → borrador propio)
// ============================================================

export async function duplicateAgent(
  tenantId: string,
  id: string,
  user: string,
): Promise<CustomAgent> {
  await ready(tenantId);
  const src = await getAgent(tenantId, id);
  if (!src) throw new Error("Agente no encontrado");
  // Un borrador ajeno no se puede duplicar (no debería ser visible siquiera)
  if (!src.isVerified && src.visibility === "private" && src.createdBy && src.createdBy !== user) {
    throw new Error("Agente no encontrado");
  }
  return createAgent(tenantId, {
    name: `${src.name} (mi versión)`.slice(0, 120),
    category: src.category,
    description: src.description,
    instructions: src.instructions,
    kbModules: src.kbModules,
    icon: src.icon,
    model: src.model,
    visibility: "private",
    createdBy: user,
  });
}

// ============================================================
// Onda 5 — catálogo de modelos con disponibilidad real
// ============================================================

export interface ModelAvailability {
  id: string;
  available: boolean;
  reason?: string;
}

export function getModelsCatalog(): ModelAvailability[] {
  const geminiOk = Boolean(process.env.GEMINI_API_KEY);
  const anthropicOk = Boolean(process.env.ANTHROPIC_API_KEY);
  return ALLOWED_AGENT_MODELS.map((id) => {
    const isClaude = id.startsWith("claude-");
    const available = isClaude ? anthropicOk : geminiOk;
    return {
      id,
      available,
      reason: available ? undefined : isClaude
        ? "Requiere ANTHROPIC_API_KEY en el backend"
        : "Requiere GEMINI_API_KEY en el backend",
    };
  });
}

// ============================================================
// Onda 5 — comparador de modelos (playground del creador)
// ============================================================

export interface ModelComparisonEntry {
  model: string;
  response: string;
  durationMs: number;
  error: string | null;
}

export async function compareModels(
  tenantId: string,
  agentId: string,
  input: { message: string; models: string[]; user: string },
): Promise<ModelComparisonEntry[]> {
  const agent = await getAgent(tenantId, agentId);
  if (!agent) throw new Error("Agente no encontrado");
  if (agent.createdBy && agent.createdBy !== input.user && !agent.isVerified) {
    throw new Error("Solo el creador puede comparar modelos de este agente");
  }
  const models = input.models.slice(0, 2).map((m) => normalizeModel(m));
  if (models.length < 2) throw new Error("Se necesitan 2 modelos para comparar");
  if (models[0] === models[1]) throw new Error("Elegí 2 modelos distintos");

  const module = agent.kbModules[0] ?? agent.category;
  const runOne = async (model: string): Promise<ModelComparisonEntry> => {
    const started = Date.now();
    try {
      const result = await chatWithAgent({
        userMessage: input.message,
        user: input.user,
        module: module === "GENERAL" ? "NO_INFORMADO" : module,
        client: "NO_INFORMADO",
        environment: "NO_INFORMADO",
        tenantId,
        systemPromptOverride: agent.instructions,
        modelOverride: model,
      });
      return { model, response: result.text, durationMs: Date.now() - started, error: null };
    } catch (err) {
      return { model, response: "", durationMs: Date.now() - started, error: (err as Error).message };
    }
  };
  // En paralelo: son solo 2 llamadas y cada una respeta el hard cap global
  return Promise.all(models.map(runOne));
}

export async function rateAgent(tenantId: string, id: string, stars: number): Promise<CustomAgent | null> {
  await ready(tenantId);
  const s = Math.max(1, Math.min(5, Math.round(stars)));
  const { rows } = await query<AgentRow>(
    `UPDATE custom_agents
        SET rating = ((rating * rating_count) + $3) / (rating_count + 1),
            rating_count = rating_count + 1,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2
      RETURNING *`,
    [id, tenantId, s],
  );
  return rows[0] ? mapAgent(rows[0]) : null;
}

// ============================================================
// Chat con un agente custom (multi-turn persistente)
// ============================================================

export async function chatWithCustomAgent(
  tenantId: string,
  agentId: string,
  input: {
    message: string;
    user: string;
    client?: string;
    environment?: string;
    /** Si viene, continúa esa conversación (historial + persistencia). */
    conversationId?: string;
  },
): Promise<{ agent: CustomAgent; result: ClaudeChatResult; conversationId: string }> {
  const agent = await getAgent(tenantId, agentId);
  if (!agent) throw new Error("Agente no encontrado");
  if (agent.status !== "active") throw new Error("El agente está archivado");
  // Un borrador (private) solo lo puede probar su creador — playground del builder.
  if (
    !agent.isVerified &&
    agent.visibility === "private" &&
    agent.createdBy &&
    agent.createdBy !== input.user
  ) {
    throw new Error("Este agente es un borrador privado: solo su creador puede chatear hasta que lo publique");
  }

  const conv = await import("./agent-conversations.service");

  // Conversación: continuar o crear nueva
  let conversationId = input.conversationId ?? "";
  let historyBlock = "";
  if (conversationId) {
    historyBlock = await conv.buildHistoryBlock(tenantId, conversationId).catch(() => "");
  } else {
    const created = await conv.createConversation(tenantId, agentId, input.user, input.message);
    conversationId = created.id;
  }

  await conv.appendMessage(tenantId, conversationId, "user", input.message).catch((err) =>
    logger.debug({ err }, "append user msg fail (non-blocking)"));

  // El módulo del agente scoped el RAG. Si el agente cubre varios módulos KB,
  // usamos el primero como filtro primario (el RAG hace fallback a global).
  const module = agent.kbModules[0] ?? agent.category;

  const result = await chatWithAgent({
    userMessage: historyBlock ? `${historyBlock}${input.message}` : input.message,
    user: input.user,
    module: module === "GENERAL" ? "NO_INFORMADO" : module,
    client: input.client ?? "NO_INFORMADO",
    environment: input.environment ?? "NO_INFORMADO",
    tenantId,
    systemPromptOverride: agent.instructions,
    // Onda 4.1 — cada agente usa su modelo (claude-* enruta a Anthropic)
    modelOverride: agent.model,
  });

  await conv.appendMessage(tenantId, conversationId, "agent", result.text, {
    model: result.model,
    confidence: result.confidence,
    ragCount: result.ragSources?.length ?? 0,
  }).catch((err) => logger.debug({ err }, "append agent msg fail (non-blocking)"));

  // Fire-and-forget: contador de uso
  query(
    `UPDATE custom_agents SET chat_count = chat_count + 1 WHERE id = $1 AND tenant_id = $2`,
    [agentId, tenantId],
  ).catch((err) => logger.debug({ err }, "chat_count update fail (non-blocking)"));

  return { agent, result, conversationId };
}
