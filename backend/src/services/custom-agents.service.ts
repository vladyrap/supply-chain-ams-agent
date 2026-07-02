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
  visibility: "private" | "team" | "public";
  isVerified: boolean;
  status: "active" | "archived";
  rating: number;
  ratingCount: number;
  chatCount: number;
  createdBy: string | null;
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
  visibility?: "private" | "team" | "public";
  createdBy?: string | null;
}

export const AGENT_CATEGORIES = [
  "MM", "SD", "PP", "FI", "CO", "BTP", "EWM", "INTEGRACION",
  "PRODUCTIVIDAD", "REPORTING", "GENERAL",
] as const;

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
  visibility: string;
  is_verified: boolean;
  status: string;
  rating: string;
  rating_count: number;
  chat_count: number;
  created_by: string | null;
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
    visibility: r.visibility as CustomAgent["visibility"],
    isVerified: r.is_verified,
    status: r.status as CustomAgent["status"],
    rating: Number(r.rating),
    ratingCount: r.rating_count,
    chatCount: r.chat_count,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ============================================================
// CRUD
// ============================================================

export async function listAgents(
  tenantId: string,
  filters: { category?: string; createdBy?: string; verifiedOnly?: boolean; search?: string } = {},
): Promise<CustomAgent[]> {
  await ready(tenantId);
  const conds: string[] = [`tenant_id = $1`, `status = 'active'`];
  const params: unknown[] = [tenantId];
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

export async function createAgent(tenantId: string, input: CreateAgentInput): Promise<CustomAgent> {
  await ready(tenantId);
  if (!input.name?.trim()) throw new Error("name es obligatorio");
  if (!input.instructions?.trim()) throw new Error("instructions es obligatorio");
  const { rows } = await query<AgentRow>(
    `INSERT INTO custom_agents
       (tenant_id, name, category, description, instructions, kb_modules, icon, visibility, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      tenantId,
      input.name.trim(),
      input.category || "GENERAL",
      input.description?.trim() ?? "",
      input.instructions.trim(),
      input.kbModules ?? [],
      input.icon || "🤖",
      input.visibility ?? "private",
      input.createdBy ?? null,
    ],
  );
  return mapAgent(rows[0]!);
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
