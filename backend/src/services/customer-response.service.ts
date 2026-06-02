// =============================================================================
// Customer Response Service — persistencia backend
// =============================================================================
// Tabla customer_responses para guardar las respuestas generadas por el
// Customer Response Intelligence del frontend. Permite sincronizar entre
// devices, auditar por backend, y eventualmente disparar envío real (SMTP/Jira).
// =============================================================================

import { logger } from "../utils/logger";
import { query } from "../database/db";

/**
 * Shape persistido — espejo del CustomerResponse del frontend pero con
 * los campos críticos para query:
 *  - response_id (PK)
 *  - ticket_key (FK lógica)
 *  - response_type, audience, tone, confidence
 *  - subject, body, summary
 *  - status, can_send
 *  - quality_score
 *  - generated_by, created_at, updated_at
 *  - full_payload (jsonb con TODO el shape original)
 */
export interface CustomerResponseRow {
  response_id: string;
  ticket_key: string;
  response_type: string;
  audience: string;
  tone: string;
  confidence: string;
  subject: string;
  body: string;
  summary: string;
  status: string;
  can_send: boolean;
  quality_score: number;
  generated_by: string;
  created_at: string;
  updated_at: string;
  full_payload: Record<string, unknown>;
}

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS customer_responses (
      response_id     TEXT PRIMARY KEY,
      ticket_key      TEXT NOT NULL,
      response_type   TEXT NOT NULL,
      audience        TEXT NOT NULL,
      tone            TEXT NOT NULL,
      confidence      TEXT NOT NULL,
      subject         TEXT NOT NULL,
      body            TEXT NOT NULL,
      summary         TEXT,
      status          TEXT NOT NULL DEFAULT 'DRAFT',
      can_send        BOOLEAN NOT NULL DEFAULT TRUE,
      quality_score   INT NOT NULL DEFAULT 0,
      generated_by    TEXT NOT NULL,
      full_payload    JSONB NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_customer_responses_ticket ON customer_responses(ticket_key);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_customer_responses_status ON customer_responses(status);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_customer_responses_created ON customer_responses(created_at DESC);`);
  schemaReady = true;
  logger.info("customer_responses schema OK");
}

export interface SaveCustomerResponseInput {
  responseId: string;
  ticketKey: string;
  responseType: string;
  audience: string;
  tone: string;
  confidence: string;
  subject: string;
  body: string;
  summary?: string;
  status: string;
  canSend: boolean;
  qualityScore: number;
  generatedBy: string;
  fullPayload: Record<string, unknown>;
}

/**
 * Upsert: si existe el responseId actualiza, si no inserta.
 */
export async function saveCustomerResponse(input: SaveCustomerResponseInput): Promise<CustomerResponseRow | null> {
  await ensureSchema();
  const { rows } = await query<CustomerResponseRow>(
    `INSERT INTO customer_responses (
      response_id, ticket_key, response_type, audience, tone, confidence,
      subject, body, summary, status, can_send, quality_score, generated_by, full_payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
    ON CONFLICT (response_id) DO UPDATE SET
      response_type   = EXCLUDED.response_type,
      audience        = EXCLUDED.audience,
      tone            = EXCLUDED.tone,
      confidence      = EXCLUDED.confidence,
      subject         = EXCLUDED.subject,
      body            = EXCLUDED.body,
      summary         = EXCLUDED.summary,
      status          = EXCLUDED.status,
      can_send        = EXCLUDED.can_send,
      quality_score   = EXCLUDED.quality_score,
      full_payload    = EXCLUDED.full_payload,
      updated_at      = now()
    RETURNING *`,
    [
      input.responseId, input.ticketKey, input.responseType, input.audience,
      input.tone, input.confidence, input.subject, input.body,
      input.summary ?? "", input.status, input.canSend, input.qualityScore,
      input.generatedBy, JSON.stringify(input.fullPayload),
    ],
  );
  return rows[0] ?? null;
}

export async function listCustomerResponsesByTicket(ticketKey: string): Promise<CustomerResponseRow[]> {
  await ensureSchema();
  const { rows } = await query<CustomerResponseRow>(
    `SELECT * FROM customer_responses
       WHERE ticket_key = $1
       ORDER BY created_at DESC
       LIMIT 50`,
    [ticketKey],
  );
  return rows;
}

export async function getCustomerResponse(responseId: string): Promise<CustomerResponseRow | null> {
  await ensureSchema();
  const { rows } = await query<CustomerResponseRow>(
    `SELECT * FROM customer_responses WHERE response_id = $1 LIMIT 1`,
    [responseId],
  );
  return rows[0] ?? null;
}

export async function updateCustomerResponseStatus(
  responseId: string, status: string,
): Promise<CustomerResponseRow | null> {
  await ensureSchema();
  const { rows } = await query<CustomerResponseRow>(
    `UPDATE customer_responses SET status = $1, updated_at = now()
       WHERE response_id = $2 RETURNING *`,
    [status, responseId],
  );
  return rows[0] ?? null;
}

export async function deleteCustomerResponse(responseId: string): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await query(
    `DELETE FROM customer_responses WHERE response_id = $1`,
    [responseId],
  );
  return (rowCount ?? 0) > 0;
}
