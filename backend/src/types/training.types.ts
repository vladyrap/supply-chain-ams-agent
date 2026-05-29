// Tipos del Centro de Entrenamiento del Agente (backend).
// Mirror del shape del frontend para serializar 1:1.

export type KnowledgeType =
  | "INCIDENT_SOLUTION" | "RCA" | "FUNCTIONAL_STEP" | "SAP_CONFIG"
  | "KNOWN_ERROR" | "FAQ" | "MEETING_MINUTES" | "TEST_CASE"
  | "AMS_PROCEDURE" | "USER_GUIDE";

export type KnowledgeStatus =
  | "DRAFT" | "PENDING_REVIEW" | "VALIDATED" | "PUBLISHED" | "ARCHIVED" | "REJECTED";

export type Priority = "low" | "medium" | "high" | "critical";

export type ValidationStage =
  | "PENDING_FUNCTIONAL" | "PENDING_TECHNICAL" | "FULLY_VALIDATED" | "NOT_REQUIRED";

export interface KnowledgeItemRow {
  id: string;
  title: string;
  content: string;
  summary: string;
  module: string;
  process: string;
  type: KnowledgeType;
  source: string;
  tags: string[];
  priority: Priority;
  status: KnowledgeStatus;
  score: number;
  version: string;
  author: string;
  created_at: string;
  updated_at: string;
  validated_by: string | null;
  published_at: string | null;
  validation_stage: ValidationStage;
  functional_validated_by: string | null;
  technical_validated_by: string | null;
  rejection_reason: string | null;
}

export interface TrainingQARow {
  id: string;
  knowledge_item_id: string;
  question: string;
  expected_answer: string;
  approved: boolean;
  created_at: string;
}

export type TrainingVersionStatus =
  | "DRAFT" | "READY" | "PUBLISHED" | "ROLLED_BACK" | "ARCHIVED";

export interface TrainingVersionRow {
  id: string;
  version: string;
  description: string;
  status: TrainingVersionStatus;
  item_count: number;
  validated_count: number;
  published_count: number;
  created_by: string;
  created_at: string;
  published_at: string | null;
  changelog: string[];
}

export type GapStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "DISMISSED";

export interface KnowledgeGapRow {
  id: string;
  title: string;
  description: string;
  module: string;
  process: string;
  priority: Priority;
  suggested_action: string;
  status: GapStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface TrainingSettingsRow {
  id: string;
  min_score_to_publish: number;
  require_functional_validation: boolean;
  require_technical_validation: boolean;
  allow_auto_publish: boolean;
  active_modules: string[];
  main_language: "es" | "en";
  response_format: "concise" | "structured" | "narrative";
  version_retention: number;
  strict_mode: boolean;
  updated_at: string;
}
