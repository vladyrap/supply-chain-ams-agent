// =============================================================
// Tool catalog: funciones que Gemini puede invocar autónomamente
// =============================================================
// Cada tool tiene:
//   - declaration: schema JSON para Gemini (parameters)
//   - execute: implementación TS que devuelve el resultado
//   - description: explica al modelo cuándo usarla
//
// Diseño:
//   - Solo herramientas READ (no escritura) — el agente NUNCA modifica datos
//   - Auditoría: cada tool call se loggea
// =============================================================
import { logger } from "../utils/logger";
import {
  getPurchaseOrder, listPurchaseOrders, getSalesOrder, listSalesOrders,
  getMaterial, listMaterials, listMovements,
} from "./sap.service";
import { searchArticles } from "./support/kb.service";
import { retrieveRelevantChunks } from "./rag.service";

// Schema "FunctionDeclaration" formato de Gemini
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ToolExecuteContext {
  /** Tenant scoping — obligatorio para queries multi-tenant */
  tenantId: string;
  /** Para filtros y auditoría */
  module?: string;
  client?: string;
  conversationId?: string;
}

export interface ToolDefinition {
  decl: ToolDeclaration;
  execute(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<unknown>;
}

// ============================================================
// SAP Read-Only tools
// ============================================================
const TOOLS: Record<string, ToolDefinition> = {
  sap_get_purchase_order: {
    decl: {
      name: "sap_get_purchase_order",
      description: "Consulta una orden de compra (PO) específica en SAP por su número. Devuelve cabecera + items con material, cantidad, precio, fechas, estado de liberación y si tiene entradas de mercancía pendientes. Úsala SIEMPRE que el usuario mencione un número de PO/OC.",
      parameters: {
        type: "object",
        properties: {
          po_number: { type: "string", description: "Número de la orden de compra, ej '4500001234'" },
        },
        required: ["po_number"],
      },
    },
    async execute(args) {
      const po = String(args.po_number || "").trim();
      if (!po) return { error: "po_number requerido" };
      const data = await getPurchaseOrder(po);
      if (!data) return { found: false, po_number: po };
      return { found: true, ...data };
    },
  },

  sap_list_purchase_orders: {
    decl: {
      name: "sap_list_purchase_orders",
      description: "Lista hasta 50 órdenes de compra recientes, opcionalmente filtradas por proveedor o estado. Úsala cuando el usuario pregunta de forma general sobre OCs sin dar un número específico.",
      parameters: {
        type: "object",
        properties: {
          vendor: { type: "string", description: "Filtro por código de proveedor (opcional)" },
          status: { type: "string", description: "Filtro por estado, ej 'Released', 'Awaiting' (opcional)" },
        },
      },
    },
    async execute(args) {
      const data = await listPurchaseOrders({
        vendor: args.vendor as string | undefined,
        status: args.status as string | undefined,
      });
      return { count: data.length, purchase_orders: data };
    },
  },

  sap_get_sales_order: {
    decl: {
      name: "sap_get_sales_order",
      description: "Consulta un pedido de venta (SO) por número. Devuelve cabecera + items con material, precios, condición PR00, fechas. Úsala cuando el usuario mencione un número de pedido de venta.",
      parameters: {
        type: "object",
        properties: {
          so_number: { type: "string", description: "Número de pedido de venta, ej '12345'" },
        },
        required: ["so_number"],
      },
    },
    async execute(args) {
      const so = String(args.so_number || "").trim();
      if (!so) return { error: "so_number requerido" };
      const data = await getSalesOrder(so);
      if (!data) return { found: false, so_number: so };
      return { found: true, ...data };
    },
  },

  sap_list_sales_orders: {
    decl: {
      name: "sap_list_sales_orders",
      description: "Lista pedidos de venta recientes (hasta 50).",
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      const data = await listSalesOrders();
      return { count: data.length, sales_orders: data };
    },
  },

  sap_get_material: {
    decl: {
      name: "sap_get_material",
      description: "Consulta el maestro de materiales (MARA/MARC/MBEW) de un material. Devuelve descripción, tipo, grupo, vistas por centro (MRP, SS, ROP), stock por centro/almacén (libre, QM, bloqueado). Útil para diagnosticar problemas como 'material no extendido al centro', 'stock 0', etc.",
      parameters: {
        type: "object",
        properties: {
          material: { type: "string", description: "Código del material, ej 'MAT-5500' o 'XYZ'" },
        },
        required: ["material"],
      },
    },
    async execute(args) {
      const mat = String(args.material || "").trim();
      if (!mat) return { error: "material requerido" };
      const data = await getMaterial(mat);
      if (!data) return { found: false, material: mat };
      return { found: true, ...data };
    },
  },

  sap_list_materials: {
    decl: {
      name: "sap_list_materials",
      description: "Lista todos los materiales conocidos (catálogo). Útil cuando el usuario pregunta '¿qué materiales tengo?' o similar.",
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      const data = await listMaterials();
      return { count: data.length, materials: data };
    },
  },

  sap_list_stock_movements: {
    decl: {
      name: "sap_list_stock_movements",
      description: "Lista los últimos movimientos de stock (MSEG / MIGO). Filtros opcionales por material o centro. Tipos comunes: 101 entrada, 601 salida, 311 traspaso.",
      parameters: {
        type: "object",
        properties: {
          material: { type: "string", description: "Filtro por material (opcional)" },
          plant: { type: "string", description: "Filtro por centro (opcional)" },
        },
      },
    },
    async execute(args) {
      const data = await listMovements({
        material: args.material as string | undefined,
        plant: args.plant as string | undefined,
      });
      return { count: data.length, movements: data };
    },
  },

  // ============================================================
  // Knowledge tools (KB curada + RAG documental)
  // ============================================================
  kb_search: {
    decl: {
      name: "kb_search",
      description: "Busca artículos aprobados en la KB curada (problema → solución) por texto y opcionalmente sistema SAP. Devuelve hasta 5 matches con título, problema y solución. Úsala ANTES de inventar una solución para ver si ya hay un procedimiento aprobado.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Texto a buscar (síntomas o keywords)" },
          system: {
            type: "string",
            description: "Filtro por módulo SAP (opcional)",
            enum: ["MM", "SD", "PP", "WM", "EWM", "QM", "PM", "ARIBA", "IBP", "BTP", "INTEGRACION"],
          },
        },
        required: ["query"],
      },
    },
    async execute(args, ctx) {
      const q = String(args.query || "").trim();
      const sys = (args.system as string | undefined) ?? ctx.module;
      const arts = await searchArticles(ctx.tenantId, { text: q, system: sys, limit: 5 });
      return {
        count: arts.length,
        articles: arts.map((a) => ({
          id: a.id, title: a.title, system: a.system, category: a.category,
          problem: a.problem.slice(0, 500),
          solution: a.solution,
          helpful_count: a.helpful_count,
        })),
      };
    },
  },

  rag_search: {
    decl: {
      name: "rag_search",
      description: "Busca fragmentos relevantes en la documentación interna (PDFs, blueprints, manuales) usando similitud semántica. Úsala cuando el usuario pide info que NO está en la KB curada pero podría estar en documentos.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Pregunta o texto a buscar" },
          system: { type: "string", description: "Módulo SAP (opcional)" },
        },
        required: ["query"],
      },
    },
    async execute(args, ctx) {
      const q = String(args.query || "").trim();
      const sys = (args.system as string | undefined) ?? ctx.module;
      const chunks = await retrieveRelevantChunks(q, { module: sys, client: ctx.client });
      return {
        count: chunks.length,
        chunks: chunks.map((c) => ({
          source_file: c.sourceFile,
          chunk_index: c.chunkIndex,
          score: c.score,
          content: c.content.slice(0, 800),
        })),
      };
    },
  },
};

// ============================================================
// API pública
// ============================================================
export function listToolDeclarations(): ToolDeclaration[] {
  return Object.values(TOOLS).map((t) => t.decl);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecuteContext
): Promise<unknown> {
  const t = TOOLS[name];
  if (!t) {
    logger.warn({ name }, "tool desconocido");
    return { error: `tool '${name}' no existe` };
  }
  try {
    logger.info({ name, args }, "tool.execute");
    const result = await t.execute(args, ctx);
    return result;
  } catch (err) {
    logger.error({ err, name }, "tool execute fail");
    return { error: err instanceof Error ? err.message : "tool execution error" };
  }
}

export interface ToolCallLog {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
}
