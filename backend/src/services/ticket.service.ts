import { logger } from "../utils/logger";
import { query } from "../database/db";
import {
  autoEstimateTicketResolution,
  type TicketEstimatedResolution, type SeverityLevel,
  type EnvironmentLevel, type ComplexityLevel,
} from "../utils/estimation";

export type TicketSource = "jira" | "mock" | "user";

export interface Ticket {
  source: TicketSource;
  key: string;            // Ej "AMS-123"
  title: string;
  description: string;
  status: string;         // Open / In Progress / Done / etc
  priority: string;       // Highest / High / Medium / Low
  reporter: string | null;
  assignee: string | null;
  sapModule?: string | null;
  environment?: string | null;
  created: string;
  updated: string;
  url?: string;
  /** Autoestimación generada al crear el ticket. */
  estimatedResolution?: TicketEstimatedResolution | null;
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: string | unknown;
    status?: { name: string };
    priority?: { name: string };
    reporter?: { displayName?: string };
    assignee?: { displayName?: string } | null;
    created: string;
    updated: string;
  };
}

interface JiraSearchResp {
  issues: JiraIssue[];
  total: number;
}

function getJiraEnv() {
  const base = process.env.JIRA_BASE_URL?.replace(/\/+$/, "");
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const project = process.env.JIRA_PROJECT_KEY;
  if (!base || !email || !token) return null;
  return { base, email, token, project };
}

function jiraDescriptionToText(desc: unknown): string {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  // ADF (Atlassian Document Format): aplanamos texto.
  if (typeof desc === "object" && desc !== null && "content" in desc) {
    type Node = { type?: string; text?: string; content?: Node[] };
    const walk = (n: Node): string => {
      if (n.text) return n.text;
      if (Array.isArray(n.content)) return n.content.map(walk).join(n.type === "paragraph" ? "\n" : "");
      return "";
    };
    return walk(desc as Node).trim();
  }
  return JSON.stringify(desc);
}

async function fetchFromJira(): Promise<Ticket[]> {
  const env = getJiraEnv();
  if (!env) return [];
  const jql = env.project
    ? `project = "${env.project}" ORDER BY updated DESC`
    : `ORDER BY updated DESC`;
  const url = `${env.base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=50`;
  const auth = Buffer.from(`${env.email}:${env.token}`).toString("base64");
  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "Jira devolvió error, caemos a mock");
      return [];
    }
    const data = (await resp.json()) as JiraSearchResp;
    return (data.issues || []).map((i): Ticket => ({
      source: "jira",
      key: i.key,
      title: i.fields.summary,
      description: jiraDescriptionToText(i.fields.description),
      status: i.fields.status?.name ?? "Unknown",
      priority: i.fields.priority?.name ?? "Medium",
      reporter: i.fields.reporter?.displayName ?? null,
      assignee: i.fields.assignee?.displayName ?? null,
      created: i.fields.created,
      updated: i.fields.updated,
      url: `${env.base}/browse/${i.key}`,
    }));
  } catch (err) {
    logger.warn({ err }, "Jira fetch falló, caemos a mock");
    return [];
  }
}

// Tickets sintéticos para demo sin Jira real
const MOCK_TICKETS: Ticket[] = [
  {
    source: "mock", key: "AMS-101",
    title: "MIGO arroja error M7 022 al recibir mercancía",
    description: "Al intentar contabilizar la entrada de mercancía contra OC 4500001234, MIGO devuelve 'M7 022: material XYZ no existe en centro 1100'. El material está activo en centro 1000.",
    status: "Open", priority: "High",
    reporter: "Comprador Demo", assignee: null,
    created: "2026-05-23T10:15:00Z", updated: "2026-05-25T09:30:00Z",
  },
  {
    source: "mock", key: "AMS-102",
    title: "MRP no genera propuestas para material crítico",
    description: "El MRP del centro 1200 no está generando propuestas para el material MAT-5500. Stock actual: 0. Demanda confirmada: 200 ud.",
    status: "In Progress", priority: "Highest",
    reporter: "Planificador PP", assignee: "Pedro Pérez",
    created: "2026-05-24T14:22:00Z", updated: "2026-05-25T11:00:00Z",
  },
  {
    source: "mock", key: "AMS-103",
    title: "Pedido de venta no determina precio",
    description: "Pedido 12345, cliente CL-200, material MAT-700. El esquema de cálculo dispara pero no toma la condición PR00. La condición tiene registro vigente en KONP.",
    status: "Open", priority: "Medium",
    reporter: "Ana Soto", assignee: null,
    created: "2026-05-25T08:45:00Z", updated: "2026-05-25T08:45:00Z",
  },
  {
    source: "mock", key: "AMS-104",
    title: "Entrega VL01N: salida de mercancía falla con error WM",
    description: "Al hacer PGI de la entrega 80012345 el sistema responde 'No hay stock disponible en almacén 100'. Stock confirmado en MMBE en almacén 100, área de picking 100-A.",
    status: "Open", priority: "High",
    reporter: "Logística", assignee: null,
    created: "2026-05-25T10:10:00Z", updated: "2026-05-25T10:10:00Z",
  },
  {
    source: "mock", key: "AMS-105",
    title: "Configurar estrategia de liberación para compras > 100K USD",
    description: "Solicitud del cliente: nueva estrategia para PO de capex sobre 100.000 USD que requiera aprobación de director financiero y CEO.",
    status: "Open", priority: "Low",
    reporter: "Gerencia Compras", assignee: null,
    created: "2026-05-25T11:00:00Z", updated: "2026-05-25T11:00:00Z",
  },
];

// ============================================================
// Tickets creados desde la UI · persistencia Postgres
// Tabla tickets_demo idempotente. Schema migra al primer uso.
// Sobrevive reinicios del backend. Recalculable y editable manualmente.
// ============================================================

let ticketsDemoSchemaReady = false;
let mocksSeedRan = false;
let ticketCounterCache: number | null = null;

async function ensureTicketsDemoSchema(): Promise<void> {
  if (ticketsDemoSchemaReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS tickets_demo (
        key                   TEXT PRIMARY KEY,
        title                 TEXT NOT NULL,
        description           TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'Open',
        priority              TEXT NOT NULL DEFAULT 'Medium',
        reporter              TEXT,
        assignee              TEXT,
        sap_module            TEXT,
        environment           TEXT,
        estimated_resolution  JSONB,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_tickets_demo_created ON tickets_demo (created_at DESC);`);
    ticketsDemoSchemaReady = true;
    await seedMockTicketsIfMissing();
  } catch (err) {
    logger.warn({ err }, "ensure tickets_demo schema failed");
  }
}

/**
 * Inserta los mocks demo (AMS-101..105) en tickets_demo si no existen.
 * ON CONFLICT DO NOTHING — idempotente. Cada mock recibe su autoestimación
 * al insertarse para que tengan banda horas/días desde el primer GET.
 */
async function seedMockTicketsIfMissing(): Promise<void> {
  if (mocksSeedRan) return;
  try {
    for (const m of MOCK_TICKETS) {
      const env = (m.environment || "NO_INFORMADO").toUpperCase() as EnvironmentLevel;
      const estimate = autoEstimateTicketResolution({
        ticketId: m.key,
        origin: "demo_cliente",
        kind: "incident",
        title: m.title,
        description: m.description,
        sapModule: m.sapModule || undefined,
        environment: env,
        severity: priorityToSeverity(m.priority),
        isProductive: env === "PRD",
        hasErrorEvidence: m.description.length > 80,
      });
      await query(
        `INSERT INTO tickets_demo
           (key, title, description, status, priority, reporter, assignee,
            sap_module, environment, estimated_resolution, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
         ON CONFLICT (key) DO NOTHING`,
        [m.key, m.title, m.description, m.status, m.priority,
         m.reporter, m.assignee, m.sapModule ?? null, m.environment ?? null,
         JSON.stringify(estimate), m.created, m.updated]
      );
    }
    mocksSeedRan = true;
  } catch (err) {
    logger.warn({ err }, "seed mock tickets failed");
  }
}

/**
 * Espejo de un ticket externo (Jira o cualquier fuente no-DB) en tickets_demo.
 * Sirve para que las ediciones de estimación (recalc/ajuste manual) tengan
 * dónde persistirse aunque la fuente de verdad sea Jira. Idempotente.
 */
async function ensureTicketMirror(key: string): Promise<Ticket | null> {
  await ensureTicketsDemoSchema();
  // 1. Ya está en DB → devolverlo
  const existing = await getUserTicketByKey(key);
  if (existing) return existing;
  // 2. Buscar en Jira (los mocks ya están en DB tras el seed)
  const env = getJiraEnv();
  let source: Ticket | null = null;
  if (env) {
    const jiraList = await fetchFromJira();
    source = jiraList.find((t) => t.key === key) ?? null;
  }
  if (!source) {
    // Fallback: mock por si el seed aún no corrió (raro)
    source = MOCK_TICKETS.find((t) => t.key === key) ?? null;
  }
  if (!source) return null;
  // 3. Calcular estimación + INSERT espejo
  const e = (source.environment || "NO_INFORMADO").toUpperCase() as EnvironmentLevel;
  const estimate = source.estimatedResolution ?? autoEstimateTicketResolution({
    ticketId: source.key,
    origin: source.source === "jira" ? "jira_demo" : "demo_cliente",
    kind: "incident",
    title: source.title,
    description: source.description,
    sapModule: source.sapModule || undefined,
    environment: e,
    severity: priorityToSeverity(source.priority),
    isProductive: e === "PRD",
    hasErrorEvidence: source.description.length > 80,
  });
  await query(
    `INSERT INTO tickets_demo
       (key, title, description, status, priority, reporter, assignee,
        sap_module, environment, estimated_resolution, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     ON CONFLICT (key) DO NOTHING`,
    [source.key, source.title, source.description, source.status, source.priority,
     source.reporter, source.assignee, source.sapModule ?? null, source.environment ?? null,
     JSON.stringify(estimate), source.created, source.updated]
  );
  return getUserTicketByKey(key);
}

interface TicketRow {
  key: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  reporter: string | null;
  assignee: string | null;
  sap_module: string | null;
  environment: string | null;
  estimated_resolution: TicketEstimatedResolution | null;
  created_at: string;
  updated_at: string;
}

function rowToTicket(r: TicketRow): Ticket {
  return {
    source: "user",
    key: r.key,
    title: r.title,
    description: r.description,
    status: r.status,
    priority: r.priority,
    reporter: r.reporter,
    assignee: r.assignee,
    sapModule: r.sap_module,
    environment: r.environment,
    created: r.created_at,
    updated: r.updated_at,
    estimatedResolution: r.estimated_resolution,
  };
}

async function nextTicketKey(): Promise<string> {
  // Counter cacheado para evitar SELECT max() en cada create. Se inicializa
  // al primer uso buscando el max key tipo AMS-NNN existente.
  if (ticketCounterCache === null) {
    try {
      const { rows } = await query<{ max_n: number | null }>(
        `SELECT MAX(CAST(SUBSTRING(key FROM 'AMS-(\\d+)') AS INTEGER)) AS max_n FROM tickets_demo`
      );
      ticketCounterCache = Math.max(200, rows[0]?.max_n ?? 0);
    } catch {
      ticketCounterCache = 200;
    }
  }
  ticketCounterCache += 1;
  return `AMS-${ticketCounterCache}`;
}

function priorityToSeverity(priority: string): SeverityLevel {
  const p = priority.toLowerCase();
  if (p.includes("highest") || p.includes("critical")) return "CRITICAL";
  if (p.includes("high")) return "HIGH";
  if (p.includes("low")) return "LOW";
  return "MEDIUM";
}

export interface CreateTicketInput {
  title: string;
  description: string;
  priority?: string;          // Highest / High / Medium / Low
  reporter?: string | null;
  assignee?: string | null;
  sapModule?: string | null;
  environment?: string | null;
  complexity?: ComplexityLevel;
  requiresDevelopment?: boolean;
  requiresIntegration?: boolean;
  requiresUAT?: boolean;
  requiresTransport?: boolean;
}

function buildEstimateForTicket(
  key: string,
  ticket: { title: string; description: string; priority: string; sapModule: string | null; environment: string | null },
  input: Pick<CreateTicketInput, "complexity" | "requiresDevelopment" | "requiresIntegration" | "requiresUAT" | "requiresTransport">,
): TicketEstimatedResolution | null {
  try {
    const env = (ticket.environment || "NO_INFORMADO").toUpperCase() as EnvironmentLevel;
    return autoEstimateTicketResolution({
      ticketId: key,
      origin: "manual_incident",
      kind: "incident",
      title: ticket.title,
      description: ticket.description,
      sapModule: ticket.sapModule || undefined,
      environment: env,
      severity: priorityToSeverity(ticket.priority),
      isProductive: env === "PRD",
      complexity: input.complexity,
      requiresDevelopment: input.requiresDevelopment,
      requiresIntegration: input.requiresIntegration,
      requiresUAT: input.requiresUAT,
      requiresTransport: input.requiresTransport,
      hasErrorEvidence: ticket.description.length > 80,
    });
  } catch (err) {
    logger.warn({ err, key }, "auto-estimate failed");
    return null;
  }
}

export async function createUserTicket(input: CreateTicketInput): Promise<Ticket> {
  await ensureTicketsDemoSchema();
  const key = await nextTicketKey();
  const ticketShape = {
    title: input.title.trim(),
    description: input.description.trim(),
    priority: input.priority || "Medium",
    sapModule: input.sapModule ?? null,
    environment: input.environment ?? null,
  };
  const estimate = buildEstimateForTicket(key, ticketShape, {
    complexity: input.complexity,
    requiresDevelopment: input.requiresDevelopment,
    requiresIntegration: input.requiresIntegration,
    requiresUAT: input.requiresUAT,
    requiresTransport: input.requiresTransport,
  });

  const { rows } = await query<TicketRow>(
    `INSERT INTO tickets_demo
       (key, title, description, status, priority, reporter, assignee,
        sap_module, environment, estimated_resolution)
     VALUES ($1,$2,$3,'Open',$4,$5,$6,$7,$8,$9::jsonb)
     RETURNING *`,
    [key, ticketShape.title, ticketShape.description, ticketShape.priority,
     input.reporter ?? null, input.assignee ?? null,
     ticketShape.sapModule, ticketShape.environment,
     estimate ? JSON.stringify(estimate) : null]
  );
  return rowToTicket(rows[0]!);
}

export async function listUserTickets(): Promise<Ticket[]> {
  await ensureTicketsDemoSchema();
  try {
    const { rows } = await query<TicketRow>(
      `SELECT * FROM tickets_demo ORDER BY created_at DESC LIMIT 500`
    );
    return rows.map(rowToTicket);
  } catch (err) {
    logger.warn({ err }, "list user tickets failed");
    return [];
  }
}

export async function getUserTicketByKey(key: string): Promise<Ticket | null> {
  await ensureTicketsDemoSchema();
  const { rows } = await query<TicketRow>(`SELECT * FROM tickets_demo WHERE key = $1`, [key]);
  return rows[0] ? rowToTicket(rows[0]) : null;
}

/**
 * Recalcula la autoestimación de un ticket y la actualiza.
 * Si el ticket no está en DB (caso Jira o mocks no seedados), primero
 * se espeja en tickets_demo y después se recalcula.
 * Preserva ajustes manuales salvo force=true.
 */
export async function recalculateUserTicket(
  key: string,
  options: { force?: boolean; actor?: string } = {},
): Promise<Ticket | null> {
  const ticket = await ensureTicketMirror(key);
  if (!ticket) return null;
  const current = ticket.estimatedResolution;
  if (current?.manuallyAdjusted && !options.force) {
    // Solo refrescar lastRecalculatedAt
    const next = { ...current, lastRecalculatedAt: new Date().toISOString() };
    return persistEstimate(key, next);
  }
  const fresh = buildEstimateForTicket(key, {
    title: ticket.title, description: ticket.description, priority: ticket.priority,
    sapModule: ticket.sapModule ?? null, environment: ticket.environment ?? null,
  }, {});
  if (!fresh) return ticket;
  return persistEstimate(key, fresh);
}

/**
 * Aplica un ajuste manual a la estimación del ticket. Marca manuallyAdjusted=true.
 */
export interface ManualEstimatePatch {
  totalMinHours?: number;
  totalMaxHours?: number;
  confidence?: "LOW" | "MEDIUM" | "HIGH";
  complexity?: ComplexityLevel;
}
export async function applyManualEstimatePatch(
  key: string,
  patch: ManualEstimatePatch,
  actor: string,
  reason: string,
): Promise<Ticket | null> {
  // Espejo automático si el ticket es externo (Jira) y todavía no está en DB
  const ticket = await ensureTicketMirror(key);
  if (!ticket || !ticket.estimatedResolution) return null;
  const cur = ticket.estimatedResolution;
  const next: TicketEstimatedResolution = {
    ...cur,
    ...patch,
    totalMinBusinessDays: patch.totalMinHours !== undefined
      ? +(patch.totalMinHours / 8).toFixed(1) : cur.totalMinBusinessDays,
    totalMaxBusinessDays: patch.totalMaxHours !== undefined
      ? +(patch.totalMaxHours / 8).toFixed(1) : cur.totalMaxBusinessDays,
    manuallyAdjusted: true,
    adjustedBy: actor,
    adjustmentReason: reason,
    lastRecalculatedAt: new Date().toISOString(),
  };
  return persistEstimate(key, next);
}

async function persistEstimate(key: string, est: TicketEstimatedResolution): Promise<Ticket | null> {
  const { rows } = await query<TicketRow>(
    `UPDATE tickets_demo
       SET estimated_resolution = $1::jsonb, updated_at = now()
     WHERE key = $2
     RETURNING *`,
    [JSON.stringify(est), key]
  );
  return rows[0] ? rowToTicket(rows[0]) : null;
}

export async function listTickets(): Promise<{ source: TicketSource; tickets: Ticket[] }> {
  // userTickets incluye TODO lo persistido: mocks seedeados (AMS-101..105) +
  // tickets creados desde la UI (AMS-201++) + cualquier espejo de Jira que
  // se haya editado alguna vez.
  const userTickets = await listUserTickets();
  const env = getJiraEnv();
  if (env) {
    const jiraTickets = await fetchFromJira();
    if (jiraTickets.length > 0) {
      // De-duplicar: si una key de Jira ya tiene espejo en DB, preferir el de DB
      // (puede tener edición manual). Lo demás de Jira sale fresh.
      const userKeys = new Set(userTickets.map((t) => t.key));
      const jiraNew = jiraTickets.filter((t) => !userKeys.has(t.key));
      return { source: "jira", tickets: [...userTickets, ...jiraNew] };
    }
  }
  // Sin Jira: todo viene de DB (mocks ya seedeados + user tickets)
  return { source: "mock", tickets: userTickets };
}

export async function getTicketByKey(key: string): Promise<Ticket | null> {
  const user = await getUserTicketByKey(key);
  if (user) return user;
  // Fallback al listado completo (mocks o Jira)
  const { tickets } = await listTickets();
  return tickets.find((t) => t.key === key) ?? null;
}

export interface TicketProviderStatus {
  jiraConfigured: boolean;
  jiraReachable: boolean;
  source: TicketSource;
  totalLastFetch: number;
}

export async function getTicketProviderStatus(): Promise<TicketProviderStatus> {
  const env = getJiraEnv();
  if (!env) return { jiraConfigured: false, jiraReachable: false, source: "mock", totalLastFetch: MOCK_TICKETS.length };
  // Probar /rest/api/3/myself como ping
  const auth = Buffer.from(`${env.email}:${env.token}`).toString("base64");
  try {
    const resp = await fetch(`${env.base}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (resp.ok) {
      const list = await fetchFromJira();
      return { jiraConfigured: true, jiraReachable: true, source: "jira", totalLastFetch: list.length };
    }
    return { jiraConfigured: true, jiraReachable: false, source: "mock", totalLastFetch: MOCK_TICKETS.length };
  } catch {
    return { jiraConfigured: true, jiraReachable: false, source: "mock", totalLastFetch: MOCK_TICKETS.length };
  }
}
