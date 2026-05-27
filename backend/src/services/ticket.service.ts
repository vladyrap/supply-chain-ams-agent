import { logger } from "../utils/logger";

export type TicketSource = "jira" | "mock";

export interface Ticket {
  source: TicketSource;
  key: string;            // Ej "AMS-123"
  title: string;
  description: string;
  status: string;         // Open / In Progress / Done / etc
  priority: string;       // Highest / High / Medium / Low
  reporter: string | null;
  assignee: string | null;
  created: string;
  updated: string;
  url?: string;
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

export async function listTickets(): Promise<{ source: TicketSource; tickets: Ticket[] }> {
  const env = getJiraEnv();
  if (env) {
    const jiraTickets = await fetchFromJira();
    if (jiraTickets.length > 0) return { source: "jira", tickets: jiraTickets };
  }
  return { source: "mock", tickets: MOCK_TICKETS };
}

export async function getTicketByKey(key: string): Promise<Ticket | null> {
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
