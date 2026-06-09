// Quality Evaluator backend service.
// Persistencia real en Postgres. Reemplaza localStorage.

import { query } from "../database/db";
import { logger } from "../utils/logger";

let schemaEnsured = false;

export type HallucinationRiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type TechnicalLevelFit = "TOO_SIMPLE" | "ADEQUATE" | "TOO_TECHNICAL";

export interface AgentEvaluation {
  id: string;
  incidentId: string | null;
  responseText: string;
  evaluator: string;
  role: string;
  accuracyScore: number;
  usefulnessScore: number;
  clarityScore: number;
  completenessScore: number;
  hallucinationRisk: HallucinationRiskLevel;
  technicalLevelFit: TechnicalLevelFit;
  needsHumanReview: boolean;
  canBecomeKnowledge: boolean;
  wasUsefulForClient: boolean;
  requiresEscalation: boolean;
  comments: string;
  createdAt: string;
}

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS agent_evaluations (
        id                    TEXT PRIMARY KEY,
        incident_id           TEXT,
        response_text         TEXT NOT NULL DEFAULT '',
        evaluator             TEXT NOT NULL DEFAULT 'demo',
        role                  TEXT NOT NULL DEFAULT 'AMS_CONSULTANT',
        accuracy_score        INTEGER NOT NULL DEFAULT 3 CHECK (accuracy_score BETWEEN 1 AND 5),
        usefulness_score      INTEGER NOT NULL DEFAULT 3 CHECK (usefulness_score BETWEEN 1 AND 5),
        clarity_score         INTEGER NOT NULL DEFAULT 3 CHECK (clarity_score BETWEEN 1 AND 5),
        completeness_score    INTEGER NOT NULL DEFAULT 3 CHECK (completeness_score BETWEEN 1 AND 5),
        hallucination_risk    TEXT NOT NULL DEFAULT 'LOW' CHECK (hallucination_risk IN ('LOW','MEDIUM','HIGH')),
        technical_level_fit   TEXT NOT NULL DEFAULT 'ADEQUATE'
                              CHECK (technical_level_fit IN ('TOO_SIMPLE','ADEQUATE','TOO_TECHNICAL')),
        needs_human_review    BOOLEAN NOT NULL DEFAULT false,
        can_become_knowledge  BOOLEAN NOT NULL DEFAULT false,
        was_useful_for_client BOOLEAN NOT NULL DEFAULT true,
        requires_escalation   BOOLEAN NOT NULL DEFAULT false,
        comments              TEXT NOT NULL DEFAULT '',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_aeval_incident ON agent_evaluations(incident_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_aeval_created  ON agent_evaluations(created_at DESC);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_aeval_risk     ON agent_evaluations(hallucination_risk);`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure quality eval schema failed");
  }
}

interface EvalRow {
  id: string; incident_id: string | null; response_text: string;
  evaluator: string; role: string;
  accuracy_score: number; usefulness_score: number;
  clarity_score: number; completeness_score: number;
  hallucination_risk: HallucinationRiskLevel; technical_level_fit: TechnicalLevelFit;
  needs_human_review: boolean; can_become_knowledge: boolean;
  was_useful_for_client: boolean; requires_escalation: boolean;
  comments: string; created_at: string;
}
function mapEval(r: EvalRow): AgentEvaluation {
  return {
    id: r.id, incidentId: r.incident_id,
    responseText: r.response_text, evaluator: r.evaluator, role: r.role,
    accuracyScore: r.accuracy_score, usefulnessScore: r.usefulness_score,
    clarityScore: r.clarity_score, completenessScore: r.completeness_score,
    hallucinationRisk: r.hallucination_risk, technicalLevelFit: r.technical_level_fit,
    needsHumanReview: r.needs_human_review, canBecomeKnowledge: r.can_become_knowledge,
    wasUsefulForClient: r.was_useful_for_client, requiresEscalation: r.requires_escalation,
    comments: r.comments, createdAt: r.created_at,
  };
}

export async function getSnapshot(tenantId: string): Promise<{ evaluations: AgentEvaluation[] }> {
  await ensureSchema();
  const r = await query<EvalRow>(
    "SELECT * FROM agent_evaluations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1000",
    [tenantId]
  );
  return { evaluations: r.rows.map(mapEval) };
}

export async function upsertEvaluation(tenantId: string, e: AgentEvaluation): Promise<AgentEvaluation> {
  await ensureSchema();
  const now = new Date().toISOString();
  const res = await query<EvalRow>(
    `INSERT INTO agent_evaluations (id,tenant_id,incident_id,response_text,evaluator,role,
       accuracy_score,usefulness_score,clarity_score,completeness_score,
       hallucination_risk,technical_level_fit,needs_human_review,can_become_knowledge,
       was_useful_for_client,requires_escalation,comments,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (id) DO UPDATE SET
       response_text=EXCLUDED.response_text, evaluator=EXCLUDED.evaluator, role=EXCLUDED.role,
       accuracy_score=EXCLUDED.accuracy_score, usefulness_score=EXCLUDED.usefulness_score,
       clarity_score=EXCLUDED.clarity_score, completeness_score=EXCLUDED.completeness_score,
       hallucination_risk=EXCLUDED.hallucination_risk, technical_level_fit=EXCLUDED.technical_level_fit,
       needs_human_review=EXCLUDED.needs_human_review, can_become_knowledge=EXCLUDED.can_become_knowledge,
       was_useful_for_client=EXCLUDED.was_useful_for_client, requires_escalation=EXCLUDED.requires_escalation,
       comments=EXCLUDED.comments
     WHERE agent_evaluations.tenant_id = EXCLUDED.tenant_id
     RETURNING *`,
    [e.id, tenantId, e.incidentId, e.responseText, e.evaluator, e.role,
     e.accuracyScore, e.usefulnessScore, e.clarityScore, e.completenessScore,
     e.hallucinationRisk, e.technicalLevelFit, e.needsHumanReview, e.canBecomeKnowledge,
     e.wasUsefulForClient, e.requiresEscalation, e.comments, e.createdAt || now]
  );
  return mapEval(res.rows[0]);
}

export async function deleteEvaluation(tenantId: string, id: string): Promise<void> {
  await ensureSchema();
  await query("DELETE FROM agent_evaluations WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
}

export async function resetDemo(tenantId: string): Promise<void> {
  await ensureSchema();
  await query("DELETE FROM agent_evaluations WHERE tenant_id = $1", [tenantId]);
}
