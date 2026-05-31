// Catálogo de Scope Items SAP S/4HANA Cloud — versión demo.
// Tabla persistida en Postgres con seed inicial de 12 scope items
// cubriendo los procesos típicos de Supply Chain (MM/SD/PP/EWM/QM).
// Sin conexión a SAP Solution Manager / Activate — esto es un catálogo
// estático curado que sirve para que el Agent Readiness Center calcule
// cobertura y el Decision Engine recomiende contenido relacionado.

import { query } from "../database/db";
import { logger } from "../utils/logger";

export type SapModule = "MM" | "SD" | "PP" | "EWM" | "QM" | "WM" | "ARIBA" | "IBP" | "BTP" | "INTEGRACION";

export interface SapScopeItem {
  code: string;            // ej. "1A0" (Procure-to-Pay)
  title: string;
  module: SapModule;
  process: string;         // ej. "Procure to Pay"
  subProcess?: string | null;
  description: string;
  hasKnowledge: boolean;    // se calcula al consultar
  hasPlaybook: boolean;     // idem
  hasQa: boolean;           // idem
  createdAt: string;
  updatedAt: string;
}

let schemaReady = false;
let seedRan = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS sap_scope_items (
        code         TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        module       TEXT NOT NULL,
        process      TEXT NOT NULL,
        sub_process  TEXT,
        description  TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_sap_scope_items_module ON sap_scope_items (module);`);
    schemaReady = true;
    await seedIfEmpty();
  } catch (err) {
    logger.warn({ err }, "ensure sap_scope_items schema failed");
  }
}

const SEED: Array<Omit<SapScopeItem, "hasKnowledge" | "hasPlaybook" | "hasQa" | "createdAt" | "updatedAt">> = [
  { code: "1A0", title: "Standard Procure-to-Pay", module: "MM", process: "Procure to Pay", subProcess: "PO standard",
    description: "Compra estándar: solicitud → OC → entrada de mercancía → factura → pago." },
  { code: "BMR", title: "Procurement of Services", module: "MM", process: "Procure to Pay", subProcess: "Servicios",
    description: "Compra de servicios con hoja de entrada (ML81N) y aceptación." },
  { code: "J45", title: "Subcontracting", module: "MM", process: "Procure to Pay", subProcess: "Subcontratación",
    description: "Provisión de materiales al proveedor y recepción del semiterminado/terminado." },
  { code: "BD9", title: "Sell from Stock", module: "SD", process: "Order to Cash", subProcess: "Venta desde stock",
    description: "Pedido de venta, entrega, picking, PGI y facturación." },
  { code: "BKA", title: "Sales Order Processing for Project-Based Services", module: "SD", process: "Order to Cash", subProcess: "Servicios proyecto",
    description: "Pedido de venta vinculado a proyecto WBS y facturación recurrente." },
  { code: "BJE", title: "Make-to-Stock (Discrete)", module: "PP", process: "Plan to Produce", subProcess: "MTS",
    description: "Planificación MTS, MRP, órdenes de producción y notificación." },
  { code: "1BM", title: "Make-to-Order (Standard)", module: "PP", process: "Plan to Produce", subProcess: "MTO",
    description: "Planificación MTO disparada por pedido de venta." },
  { code: "1V8", title: "Quality Management for Procurement", module: "QM", process: "Quality", subProcess: "QM en compras",
    description: "Inspección de calidad en entrada de mercancías con stock bloqueado." },
  { code: "1V9", title: "Quality Management for Production", module: "QM", process: "Quality", subProcess: "QM en producción",
    description: "Inspección durante y al final de la producción." },
  { code: "3BS", title: "Advanced Available-to-Promise (aATP)", module: "SD", process: "Order to Cash", subProcess: "ATP avanzado",
    description: "Disponibilidad avanzada con backorder processing y product allocation." },
  { code: "1VR", title: "Warehouse Inbound Processing (EWM)", module: "EWM", process: "Warehouse", subProcess: "Recepción",
    description: "Recepción de mercancías en EWM con HU + ubicaciones." },
  { code: "1VS", title: "Warehouse Outbound Processing (EWM)", module: "EWM", process: "Warehouse", subProcess: "Despacho",
    description: "Picking, packing y despacho de salidas en EWM." },
];

async function seedIfEmpty(): Promise<void> {
  if (seedRan) return;
  try {
    const { rows } = await query<{ c: string }>("SELECT count(*)::text AS c FROM sap_scope_items");
    const count = Number(rows[0]?.c ?? "0");
    if (count > 0) { seedRan = true; return; }
    for (const it of SEED) {
      await query(
        `INSERT INTO sap_scope_items (code, title, module, process, sub_process, description)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO NOTHING`,
        [it.code, it.title, it.module, it.process, it.subProcess ?? null, it.description]
      );
    }
    seedRan = true;
  } catch (err) {
    logger.warn({ err }, "seed sap_scope_items failed");
  }
}

interface ScopeItemRow {
  code: string; title: string; module: string; process: string;
  sub_process: string | null; description: string;
  created_at: string; updated_at: string;
}

function rowToItem(r: ScopeItemRow, coverage: Map<string, { kb: boolean; pb: boolean; qa: boolean }>): SapScopeItem {
  const cov = coverage.get(r.code) || { kb: false, pb: false, qa: false };
  return {
    code: r.code, title: r.title, module: r.module as SapModule, process: r.process,
    subProcess: r.sub_process, description: r.description,
    hasKnowledge: cov.kb, hasPlaybook: cov.pb, hasQa: cov.qa,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * Calcula cobertura por scope item: existe knowledge / playbook / Q&A
 * mencionando el código del scope item.
 * Implementación tolerante: si las tablas no existen, asume false.
 */
async function computeCoverage(codes: string[]): Promise<Map<string, { kb: boolean; pb: boolean; qa: boolean }>> {
  const map = new Map<string, { kb: boolean; pb: boolean; qa: boolean }>();
  for (const c of codes) map.set(c, { kb: false, pb: false, qa: false });
  // Marcadores: buscamos códigos en agent_knowledge.tags (jsonb), agent_qa.tags (jsonb),
  // o cualquier columna title/body que contenga el código. Si las tablas no existen, salimos limpio.
  try {
    const { rows } = await query<{ code: string }>(
      `SELECT DISTINCT code FROM (
         SELECT s.code FROM sap_scope_items s
         JOIN agent_knowledge k ON (k.tags @> to_jsonb(ARRAY[s.code]::text[]) OR k.title ILIKE '%' || s.code || '%')
       ) sub`
    );
    for (const r of rows) {
      const v = map.get(r.code); if (v) v.kb = true;
    }
  } catch { /* tabla no existe */ }
  try {
    const { rows } = await query<{ code: string }>(
      `SELECT DISTINCT s.code FROM sap_scope_items s
         JOIN agent_qa q ON (q.tags @> to_jsonb(ARRAY[s.code]::text[]) OR q.question ILIKE '%' || s.code || '%')`
    );
    for (const r of rows) {
      const v = map.get(r.code); if (v) v.qa = true;
    }
  } catch { /* tabla no existe */ }
  return map;
}

export async function listScopeItems(filter?: { module?: SapModule }): Promise<SapScopeItem[]> {
  await ensureSchema();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter?.module) {
    params.push(filter.module);
    where.push(`module = $${params.length}`);
  }
  const sql = `SELECT * FROM sap_scope_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY module, code`;
  const { rows } = await query<ScopeItemRow>(sql, params);
  const coverage = await computeCoverage(rows.map((r) => r.code));
  return rows.map((r) => rowToItem(r, coverage));
}

export async function getScopeItemByCode(code: string): Promise<SapScopeItem | null> {
  await ensureSchema();
  const { rows } = await query<ScopeItemRow>(`SELECT * FROM sap_scope_items WHERE code = $1`, [code]);
  if (!rows[0]) return null;
  const coverage = await computeCoverage([code]);
  return rowToItem(rows[0], coverage);
}

/**
 * Devuelve scope items que matchean un ticket por módulo + texto del título/descripción.
 * Heurística simple para sugerir items relacionados desde el Decision Engine.
 */
export async function findScopeItemsForTicket(input: {
  module?: string | null;
  title?: string;
  description?: string;
}): Promise<SapScopeItem[]> {
  const items = await listScopeItems({ module: (input.module || undefined) as SapModule | undefined });
  if (items.length === 0) return [];
  const haystack = `${input.title || ""} ${input.description || ""}`.toLowerCase();
  return items.filter((it) => {
    if (haystack.includes(it.code.toLowerCase())) return true;
    if (haystack.includes(it.process.toLowerCase())) return true;
    if (it.subProcess && haystack.includes(it.subProcess.toLowerCase())) return true;
    return false;
  });
}
