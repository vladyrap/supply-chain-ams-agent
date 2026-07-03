export type ConfidenceLevel = "baja" | "media" | "alta" | "no_detectada";

export type AttachmentMime = "image/png" | "image/jpeg" | "image/webp";

export interface Attachment {
  name: string;
  mimeType: AttachmentMime;
  sizeBytes: number;
  dataBase64: string; // sin el prefijo "data:image/...;base64,"
}

export interface AmsChatRequest {
  message: string;
  user?: string;
  module?: string;
  client?: string;
  environment?: string;
  attachments?: Attachment[];
}

export interface AmsChatInputNormalized {
  message: string;
  user: string;
  module: string;
  client: string;
  environment: string;
  attachments: Attachment[];
}

export interface AmsChatResponseMetadata {
  model: string;
  timestamp: string;
  confidence: ConfidenceLevel;
}

export interface AmsChatResponseOk {
  success: true;
  agent: "ams-supply-chain-agent";
  input: AmsChatInputNormalized;
  response: string;
  metadata: AmsChatResponseMetadata;
}

export interface AmsChatResponseError {
  success: false;
  error: string;
}

export interface IncidentAttachmentMeta {
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface IncidentRecord {
  id: string;
  user_name: string | null;
  client_name: string | null;
  sap_module: string | null;
  environment: string | null;
  message: string;
  response: string | null;
  confidence: string | null;
  model: string | null;
  attachments: IncidentAttachmentMeta[];
  created_at: string;
}

export interface AuditLogRecord {
  id: string;
  action: string;
  details: unknown;
  created_at: string;
}

export type AuditAction =
  | "CHAT_REQUEST_RECEIVED"
  | "CLAUDE_REQUEST_SENT"
  | "CLAUDE_RESPONSE_RECEIVED"
  | "INCIDENT_SAVED"
  | "ERROR"
  // RBAC / seguridad — agregado en DH v0.9
  | "UNAUTHORIZED_API_ACCESS_ATTEMPT"
  | "UNAUTHORIZED_ROUTE_ACCESS_ATTEMPT"
  // Agent Hub — v1.3
  | "CUSTOM_AGENT_CREATED"
  | "CUSTOM_AGENT_DELETED"
  | "CUSTOM_AGENT_PUBLISHED"
  | "CUSTOM_AGENT_UNPUBLISHED"
  | "AGENTIC_APP_RUN_STARTED";
