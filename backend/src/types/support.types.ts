// =============================================================
// Mesa de Soporte — types compartidos
// =============================================================

export type SupportChannel = "chat" | "whatsapp" | "voice" | "email";
export type SupportStatus =
  | "open" | "ai_handling" | "waiting_user"
  | "escalated" | "resolved" | "closed";
export type Urgency = "baja" | "media" | "alta" | "critica";
export type Priority = Urgency;
export type TicketStatus =
  | "new" | "in_progress" | "waiting_customer" | "resolved" | "closed";
export type KbStatus = "draft" | "approved" | "archived";
export type MessageRole = "user" | "ai" | "agent" | "system";

export interface SupportConversation {
  id: string;
  channel: SupportChannel;
  user_name: string | null;
  user_email: string | null;
  user_phone: string | null;
  client: string | null;
  status: SupportStatus;
  intent: string | null;
  sap_module: string | null;
  urgency: Urgency | null;
  category: string | null;
  summary: string | null;
  message_count: number;
  ai_resolved: boolean;
  escalated_to_ticket: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface SupportMessage {
  id: string;
  conversation_id: string;
  role: MessageRole;
  text: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SupportTicket {
  id: string;
  code: string;
  conversation_id: string | null;
  title: string;
  summary: string;
  system_affected: string | null;
  category: string | null;
  priority: Priority;
  sla_minutes: number;
  sla_due_at: string | null;
  assigned_role: string | null;
  assigned_to: string | null;
  status: TicketStatus;
  evidences: { type: string; label: string; value: string }[];
  resolution: string | null;
  kb_article_id: string | null;
  created_by_ai: boolean;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
}

export interface KbArticle {
  id: string;
  title: string;
  problem: string;
  solution: string;
  system: string | null;
  category: string | null;
  tags: string[];
  status: KbStatus;
  source: "manual" | "from_ticket" | "from_meeting";
  source_ticket_id: string | null;
  use_count: number;
  helpful_count: number;
  created_by: string | null;
  approved_by: string | null;
  created_at: string;
  approved_at: string | null;
}

export interface TriageResult {
  intent: string;
  sap_module: string;          // MM/SD/PP/.../NO_INFORMADO
  urgency: Urgency;
  category: string;
  title: string;
  summary: string;
  missing_data: string[];
  confidence: "baja" | "media" | "alta";
  // Si el modelo dice "esto no lo puedo resolver, hay que escalar":
  needs_escalation: boolean;
  escalation_reason?: string;
}
