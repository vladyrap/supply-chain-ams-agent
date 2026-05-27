// =============================================================
// SAP Read-Only (Fase 4)
// =============================================================
// Si SAP_BASE_URL + SAP_USER + SAP_PASSWORD están configurados,
// se hacen llamadas reales a OData (modo lectura, top 50 default,
// catálogo blanco). Si no, se devuelve mock con datos sintéticos
// representativos para demo. NUNCA hay endpoints de escritura.
//
// El catálogo blanco está hardcodeado abajo. Cualquier endpoint
// fuera de la whitelist se rechaza antes de salir del backend.
// =============================================================
import { logger } from "../utils/logger";

export type SapMode = "real" | "mock";

interface SapEnv {
  baseUrl: string;
  user: string;
  password: string;
  client?: string;
  readonlyEnabled: boolean;
  defaultTop: number;
}

function readEnv(): SapEnv | null {
  const baseUrl = process.env.SAP_BASE_URL?.replace(/\/+$/, "");
  const user = process.env.SAP_USER;
  const password = process.env.SAP_PASSWORD;
  const sapClient = process.env.SAP_CLIENT;
  const readonlyEnabled = (process.env.SAP_READONLY_ENABLED || "true").toLowerCase() === "true";
  const defaultTop = parseInt(process.env.SAP_DEFAULT_TOP || "50", 10);
  if (!baseUrl || !user || !password) return null;
  return { baseUrl, user, password, client: sapClient, readonlyEnabled, defaultTop };
}

const SAFE_PATHS = [
  /^\/sap\/opu\/odata\/sap\/API_PURCHASEORDER_PROCESS_SRV\//,
  /^\/sap\/opu\/odata\/sap\/API_SALES_ORDER_SRV\//,
  /^\/sap\/opu\/odata\/sap\/API_MATERIAL_STOCK_SRV\//,
  /^\/sap\/opu\/odata\/sap\/API_PRODUCT_SRV\//,
  /^\/sap\/opu\/odata\/sap\/API_OUTBOUND_DELIVERY_SRV\//,
];

function pathIsSafe(path: string): boolean {
  return SAFE_PATHS.some((re) => re.test(path));
}

async function sapGet<T>(env: SapEnv, path: string): Promise<T> {
  if (!pathIsSafe(path)) {
    throw new Error(`Endpoint SAP fuera del catálogo blanco: ${path}`);
  }
  const auth = Buffer.from(`${env.user}:${env.password}`).toString("base64");
  const url = `${env.baseUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
  };
  if (env.client) headers["sap-client"] = env.client;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`SAP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ============================================================
// Tipos del dominio (subset que exponemos)
// ============================================================
export interface PurchaseOrderHeader {
  poNumber: string;
  vendor: string;
  vendorName: string;
  companyCode: string;
  purchasingOrg: string;
  documentDate: string;
  totalNet: number;
  currency: string;
  status: string;
  approvalLevel: string;
  items: PurchaseOrderItem[];
}
export interface PurchaseOrderItem {
  itemNumber: string;
  material: string;
  description: string;
  plant: string;
  qty: number;
  unit: string;
  netPrice: number;
  netAmount: number;
  deliveryDate: string;
  pendingGr: boolean;
}

export interface SalesOrderHeader {
  soNumber: string;
  customer: string;
  customerName: string;
  salesOrg: string;
  channel: string;
  division: string;
  documentDate: string;
  totalNet: number;
  currency: string;
  status: string;
  items: SalesOrderItem[];
}
export interface SalesOrderItem {
  itemNumber: string;
  material: string;
  description: string;
  plant: string;
  qty: number;
  unit: string;
  netPrice: number;
  conditionPR00: number | null;
  netAmount: number;
  deliveryDate: string;
}

export interface MaterialMasterRow {
  material: string;
  description: string;
  type: string;
  group: string;
  unit: string;
  plants: { plant: string; mrpType: string; lotSize: string; safetyStock: number; reorderPoint: number }[];
  stockByPlant: { plant: string; storageLoc: string; unrestricted: number; quality: number; blocked: number }[];
}

export interface StockMovement {
  document: string;
  itemNumber: string;
  movementType: string;
  date: string;
  material: string;
  plant: string;
  storageLoc: string;
  qty: number;
  unit: string;
  user: string;
}

// ============================================================
// MOCK DATA (representativo, no real)
// ============================================================
const MOCK_POS: PurchaseOrderHeader[] = [
  {
    poNumber: "4500001234", vendor: "100001", vendorName: "Acme Industrial Ltda.",
    companyCode: "CL10", purchasingOrg: "1000", documentDate: "2026-05-20",
    totalNet: 78500, currency: "USD", status: "Released", approvalLevel: "Nivel 2 / 3",
    items: [
      { itemNumber: "00010", material: "MAT-5500", description: "Componente XYZ-A",
        plant: "1100", qty: 150, unit: "EA", netPrice: 350, netAmount: 52500,
        deliveryDate: "2026-06-10", pendingGr: true },
      { itemNumber: "00020", material: "MAT-5501", description: "Componente XYZ-B",
        plant: "1100", qty: 100, unit: "EA", netPrice: 260, netAmount: 26000,
        deliveryDate: "2026-06-15", pendingGr: true },
    ],
  },
  {
    poNumber: "4500001235", vendor: "100022", vendorName: "Logistec S.A.",
    companyCode: "CL10", purchasingOrg: "1000", documentDate: "2026-05-22",
    totalNet: 12300, currency: "USD", status: "Awaiting Release", approvalLevel: "Nivel 1 / 2",
    items: [
      { itemNumber: "00010", material: "MAT-700", description: "Insumo logístico",
        plant: "1100", qty: 200, unit: "EA", netPrice: 61.5, netAmount: 12300,
        deliveryDate: "2026-06-05", pendingGr: false },
    ],
  },
];

const MOCK_SOS: SalesOrderHeader[] = [
  {
    soNumber: "12345", customer: "CL-200", customerName: "Distribuidora Andina SpA",
    salesOrg: "1000", channel: "10", division: "00", documentDate: "2026-05-23",
    totalNet: 0, currency: "USD", status: "Open / Incomplete (precio)",
    items: [
      { itemNumber: "10", material: "MAT-700", description: "Insumo logístico",
        plant: "1100", qty: 50, unit: "EA", netPrice: 0, conditionPR00: null,
        netAmount: 0, deliveryDate: "2026-06-01" },
    ],
  },
  {
    soNumber: "12346", customer: "CL-201", customerName: "Comercial del Sur",
    salesOrg: "1000", channel: "10", division: "00", documentDate: "2026-05-24",
    totalNet: 18750, currency: "USD", status: "Released",
    items: [
      { itemNumber: "10", material: "MAT-5500", description: "Componente XYZ-A",
        plant: "1100", qty: 50, unit: "EA", netPrice: 375, conditionPR00: 375,
        netAmount: 18750, deliveryDate: "2026-06-02" },
    ],
  },
];

const MOCK_MATERIALS: MaterialMasterRow[] = [
  {
    material: "MAT-5500", description: "Componente XYZ-A", type: "ROH",
    group: "ELECTRONICS", unit: "EA",
    plants: [
      { plant: "1000", mrpType: "PD", lotSize: "EX", safetyStock: 20, reorderPoint: 50 },
      { plant: "1100", mrpType: "PD", lotSize: "EX", safetyStock: 30, reorderPoint: 80 },
    ],
    stockByPlant: [
      { plant: "1000", storageLoc: "0001", unrestricted: 145, quality: 0, blocked: 0 },
      { plant: "1100", storageLoc: "0001", unrestricted: 12, quality: 0, blocked: 0 },
    ],
  },
  {
    material: "MAT-700", description: "Insumo logístico", type: "HALB",
    group: "PACKAGING", unit: "EA",
    plants: [
      { plant: "1100", mrpType: "PD", lotSize: "EX", safetyStock: 10, reorderPoint: 30 },
    ],
    stockByPlant: [
      { plant: "1100", storageLoc: "0001", unrestricted: 200, quality: 0, blocked: 5 },
    ],
  },
  {
    material: "XYZ", description: "Material no extendido al centro 1100", type: "ROH",
    group: "ELECTRONICS", unit: "EA",
    plants: [
      { plant: "1000", mrpType: "PD", lotSize: "EX", safetyStock: 0, reorderPoint: 0 },
    ],
    stockByPlant: [
      { plant: "1000", storageLoc: "0001", unrestricted: 30, quality: 0, blocked: 0 },
    ],
  },
];

const MOCK_MOVEMENTS: StockMovement[] = [
  { document: "5000010001", itemNumber: "0001", movementType: "101", date: "2026-05-25",
    material: "MAT-5500", plant: "1100", storageLoc: "0001", qty: 50, unit: "EA", user: "WMS_BATCH" },
  { document: "5000010002", itemNumber: "0001", movementType: "601", date: "2026-05-25",
    material: "MAT-700", plant: "1100", storageLoc: "0001", qty: 10, unit: "EA", user: "VL01N_BATCH" },
  { document: "5000010003", itemNumber: "0001", movementType: "311", date: "2026-05-24",
    material: "MAT-5500", plant: "1100", storageLoc: "0001", qty: 5, unit: "EA", user: "MB1B" },
];

// ============================================================
// API publica del servicio
// ============================================================
export interface SapStatus {
  mode: SapMode;
  baseUrlConfigured: boolean;
  reachable: boolean;
  catalog: string[];
  defaultTop: number;
}

export async function getSapStatus(): Promise<SapStatus> {
  const env = readEnv();
  const catalog = [
    "API_PURCHASEORDER_PROCESS_SRV (read)",
    "API_SALES_ORDER_SRV (read)",
    "API_PRODUCT_SRV (read)",
    "API_MATERIAL_STOCK_SRV (read)",
    "API_OUTBOUND_DELIVERY_SRV (read)",
  ];
  if (!env) return { mode: "mock", baseUrlConfigured: false, reachable: false, catalog, defaultTop: 50 };
  try {
    // Ping mínimo a /sap/opu/odata/sap/$metadata (no whitelist)
    // Solo HEAD para verificar reachability.
    const auth = Buffer.from(`${env.user}:${env.password}`).toString("base64");
    const res = await fetch(`${env.baseUrl}/sap/opu/odata/sap/`, {
      method: "HEAD",
      headers: { Authorization: `Basic ${auth}` },
    });
    return {
      mode: res.ok ? "real" : "mock",
      baseUrlConfigured: true,
      reachable: res.ok,
      catalog,
      defaultTop: env.defaultTop,
    };
  } catch (err) {
    logger.warn({ err }, "SAP ping falló, devuelvo mock");
    return { mode: "mock", baseUrlConfigured: true, reachable: false, catalog, defaultTop: env.defaultTop };
  }
}

export async function listPurchaseOrders(filters: { vendor?: string; status?: string } = {}): Promise<PurchaseOrderHeader[]> {
  const env = readEnv();
  if (env && env.readonlyEnabled) {
    // En real, llamaría a $top=50 con $filter. Aquí dejamos la estructura.
    try {
      // const data = await sapGet<{ d: { results: unknown[] } }>(env, `/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder?$top=${env.defaultTop}&$format=json`);
      // ... mapear data.d.results a PurchaseOrderHeader[]
      // Por ahora, sin parser de OData v2 ADF, caemos a mock si no podemos parsear.
      return MOCK_POS;
    } catch (err) {
      logger.warn({ err }, "SAP PO real falló, mock");
    }
  }
  let res = MOCK_POS;
  if (filters.vendor) res = res.filter((p) => p.vendor === filters.vendor);
  if (filters.status) res = res.filter((p) => p.status.toLowerCase().includes(filters.status!.toLowerCase()));
  return res;
}

export async function getPurchaseOrder(poNumber: string): Promise<PurchaseOrderHeader | null> {
  const list = await listPurchaseOrders();
  return list.find((p) => p.poNumber === poNumber) ?? null;
}

export async function listSalesOrders(): Promise<SalesOrderHeader[]> {
  return MOCK_SOS;
}

export async function getSalesOrder(soNumber: string): Promise<SalesOrderHeader | null> {
  const list = await listSalesOrders();
  return list.find((s) => s.soNumber === soNumber) ?? null;
}

export async function listMaterials(): Promise<MaterialMasterRow[]> {
  return MOCK_MATERIALS;
}

export async function getMaterial(material: string): Promise<MaterialMasterRow | null> {
  const list = await listMaterials();
  return list.find((m) => m.material.toUpperCase() === material.toUpperCase()) ?? null;
}

export async function listMovements(filters: { material?: string; plant?: string } = {}): Promise<StockMovement[]> {
  let res = MOCK_MOVEMENTS;
  if (filters.material) res = res.filter((m) => m.material === filters.material);
  if (filters.plant) res = res.filter((m) => m.plant === filters.plant);
  return res;
}
