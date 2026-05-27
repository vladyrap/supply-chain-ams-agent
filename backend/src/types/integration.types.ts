// =============================================================
// Integraciones — types compartidos
// =============================================================

export type DestinationType = "webhook" | "slack" | "email" | "sap";

export type SapAdapter =
  | "cloud_alm"      // SAP Cloud ALM Incident Management
  | "s4_odata"       // S/4HANA u OData genérico (POST a $batch o endpoint específico)
  | "btp_workflow"   // BTP Workflow service trigger
  | "idoc_http"      // PI/PO HTTP receiver (XML/JSON)
  | "solman";        // Solution Manager Service Desk Web Service
export type DeliveryStatus = "pending" | "sent" | "failed";

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  secret?: string; // si se setea, agregamos HMAC-SHA256 en header X-Ams-Signature
}
export interface SlackConfig {
  webhookUrl: string;
  channel?: string;
}
export interface EmailConfig {
  to: string[];
  from?: string;
  subject_prefix?: string;
}

export interface SapConfig {
  adapter: SapAdapter;
  /** URL base del sistema SAP */
  baseUrl: string;
  /** Endpoint específico (path relativo a baseUrl). Para cloud_alm:
   *  "/services/api/itsm/v1/incidents". Para s4_odata: "/sap/opu/odata/sap/...".
   *  Para btp_workflow: "/workflow-service/rest/v1/workflow-instances".
   *  Para idoc_http: el path del receiver. Para solman: SOAP endpoint. */
  path: string;
  /** Auth */
  auth: "basic" | "bearer" | "oauth2_client_credentials" | "none";
  username?: string;          // basic
  password?: string;
  bearerToken?: string;       // bearer
  oauthTokenUrl?: string;     // oauth2
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** Cliente SAP (mandante) — añadido como query/header según adapter */
  sapClient?: string;
  /** Headers extra opcionales */
  headers?: Record<string, string>;
  /** Para s4_odata: indica si hay que fetch CSRF token primero */
  fetchCsrf?: boolean;
  /** Template del body — usa {{event.x}} y {{data.y}} como placeholders */
  bodyTemplate?: string;
}

export type DestinationConfig = WebhookConfig | SlackConfig | EmailConfig | SapConfig;

export interface IntegrationDestination {
  id: string;
  name: string;
  type: DestinationType;
  config: DestinationConfig;
  event_filter: string[];          // ["ticket.*", "meeting.done"]
  active: boolean;
  last_used_at: string | null;
  last_status: "ok" | "error" | "never" | null;
  last_error: string | null;
  delivery_count: number;
  error_count: number;
  created_at: string;
  updated_at: string;
}

export interface IntegrationDelivery {
  id: string;
  destination_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  http_status: number | null;
  response_excerpt: string | null;
  attempts: number;
  last_attempted_at: string | null;
  created_at: string;
}

// Lista canónica de eventos que la plataforma emite
export const KNOWN_EVENTS = [
  "ticket.escalated",   // Support Desk crea un ticket MESA al escalar
  "ticket.resolved",    // N2 marca el ticket como resuelto
  "ticket.closed",      // N2 cierra el ticket
  "meeting.done",       // Worker terminó de transcribir + extraer minuta
  "sap.inbound",        // SAP envió un evento entrante (idoc, dump, etc.)
  "incident.created",   // Nuevo incidente en /api/ams/chat
  "kb.created",         // Nuevo artículo KB (draft)
  "kb.approved",        // Artículo KB aprobado
  "ticket.sla_warning", // Worker autónomo: ticket cerca de vencer SLA
  "incident.anomaly",   // Worker autónomo: pico anormal de incidentes
  "conversation.stale", // Worker autónomo: conv waiting_user >24h
  "report.daily",       // Worker autónomo: reporte ejecutivo diario
  "test",               // Evento manual desde la UI
] as const;

export type KnownEvent = typeof KNOWN_EVENTS[number];
