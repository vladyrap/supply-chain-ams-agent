// =============================================================================
// audit-events.types.ts — Audit Trail rico (DH v0.9)
// =============================================================================
// Tipos para la nueva tabla audit_events (schema rico). NO confundir con
// AuditAction (audit_logs legacy) — ese se mantiene para compatibilidad.
// =============================================================================

/** Categorías para agrupar eventos en UI. */
export type AuditEventCategory =
  | "ticket"
  | "rbac"
  | "estimation"
  | "customer_response"
  | "quality"
  | "intelligence"
  | "knowledge"
  | "playbook"
  | "document"
  | "testing"
  | "escalation"
  | "security"
  | "general";

/** Severity para alerting / filtros. */
export type AuditEventSeverity = "info" | "warning" | "error" | "critical";

/** Source del evento. */
export type AuditEventSource = "ui" | "agent" | "system" | "integration" | "api";

/**
 * Tipos de evento soportados. Espejados (y extendidos) del frontend ticket
 * audit + rbac audit. Lista no exhaustiva — backend acepta TEXT, esta es
 * la lista canónica que los UI consumen.
 */
export type AuditEventType =
  // ── Ticket lifecycle ──
  | "TICKET_CREATED"
  | "TICKET_UPDATED"
  | "TICKET_CLOSED"
  | "STATUS_CHANGED"
  | "COMMENT_ADDED"
  // ── Estimation ──
  | "AUTO_ESTIMATE_GENERATED"
  | "ESTIMATE_RECALCULATED"
  | "ESTIMATION_APPLIED"
  | "CONTEXTUAL_ESTIMATION_RUN"
  | "MANUAL_ADJUSTMENT"
  // ── Agent ──
  | "TICKET_CLASSIFIED"
  | "AGENT_RESPONSE_GENERATED"
  // ── Knowledge / scope / playbook ──
  | "KNOWLEDGE_MATCHED"
  | "KNOWLEDGE_CREATED"
  | "SCOPE_ITEM_MATCHED"
  | "PLAYBOOK_SUGGESTED"
  | "PLAYBOOK_RECOMMENDED"
  | "CONVERTED_TO_KNOWLEDGE"
  // ── Escalation ──
  | "N2_ESCALATION_SUGGESTED"
  | "N2_ESCALATION_CREATED"
  | "JIRA_DEMO_CREATED"
  | "SERVICENOW_DEMO_CREATED"
  // ── Document / Testing ──
  | "DOCUMENT_GENERATED"
  | "TEST_CASE_CREATED"
  | "TEST_SCRIPT_GENERATED"
  | "QUALITY_EVALUATED"
  | "QUALITY_EVALUATION_RUN"
  // ── Customer Response ──
  | "CUSTOMER_RESPONSE_GENERATED"
  | "CUSTOMER_RESPONSE_QUALITY_CHECKED"
  | "CUSTOMER_RESPONSE_BLOCKED"
  | "CUSTOMER_RESPONSE_APPROVED"
  | "CUSTOMER_RESPONSE_SAVED"
  | "CUSTOMER_RESPONSE_SENT_MANUAL"
  // ── Intelligence ──
  | "INTELLIGENCE_ANALYSIS_RUN"
  | "N2_INTELLIGENCE_ANALYZED"
  | "N2_INTELLIGENCE_VERDICT_ESCALATE"
  | "N2_INTELLIGENCE_VERDICT_STAY"
  | "KB_CURATION_CANDIDATE_PROPOSED"
  | "KB_CURATION_APPROVED"
  | "KB_CURATION_REJECTED"
  | "KB_CURATION_PUBLISHED"
  // ── Visual ──
  | "VISUAL_EVIDENCE_ATTACHED"
  | "VISUAL_EVIDENCE_ANALYZED"
  | "TICKET_ESTIMATED_WITH_VISUAL_ANALYSIS"
  // ── Demo ──
  | "DEMO_STARTED"
  | "DEMO_STEP_COMPLETED"
  | "DEMO_COMPLETED"
  // ── RBAC ──
  | "ROLE_PERMISSIONS_UPDATED"
  | "ROLE_CREATED"
  | "ROLE_DELETED"
  | "USER_ROLE_CHANGED"
  | "RBAC_OVERRIDE_ACTIVATED"
  | "RBAC_OVERRIDE_CLEARED"
  // ── Security ──
  | "UNAUTHORIZED_API_ACCESS_ATTEMPT"
  | "UNAUTHORIZED_ROUTE_ACCESS_ATTEMPT";

/** Forma del evento al insertar en backend. */
export interface AuditEventInput {
  eventType: AuditEventType | string;       // string para permitir custom
  category?: AuditEventCategory | string;
  severity?: AuditEventSeverity;
  source?: AuditEventSource;
  ticketId?: string | null;
  actorUserId?: string | null;              // resolves desde request.user si no se pasa
  actorName?: string | null;
  actorRole?: string | null;
  payload?: Record<string, unknown> | null;
  correlationId?: string | null;
  tenantId?: string | null;
}

/** Forma de la fila persistida. */
export interface AuditEventRecord {
  id: string;
  tenantId: string | null;
  ticketId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  eventType: string;
  category: string;
  severity: string;
  payload: unknown;
  source: string;
  correlationId: string | null;
  createdAt: string;
}

/** Filtros para listar. */
export interface AuditEventFilters {
  limit?: number;
  offset?: number;
  ticketId?: string;
  eventType?: string;
  category?: string;
  severity?: string;
  actorUserId?: string;
  fromDate?: string;                        // ISO
  toDate?: string;                          // ISO
}

/** Summary aggregations. */
export interface AuditEventSummary {
  total: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
  byEventType: Array<{ eventType: string; count: number }>;
  last7Days: number;
  last24h: number;
}
