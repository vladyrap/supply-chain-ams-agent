// Persistencia del Canal Telefonico IA.
// Tablas: call_logs (una fila por llamada) + call_turns (N filas por turno).
//
// Idempotente: ensureVoiceSchema() se llama al arranque para crear las tablas
// si no existen, sin afectar instancias que ya las tienen.

import { query } from "../database/db";
import { logger } from "../utils/logger";

export type CallSpeaker = "USER" | "AI" | "SYSTEM";

export interface CallLogRow {
  id: string;
  call_sid: string;
  from_number: string | null;
  to_number: string | null;
  call_status: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  ai_responses: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CallTurnRow {
  id: string;
  call_sid: string;
  speaker: CallSpeaker;
  message: string;
  created_at: string;
}

// =====================================================
// Schema bootstrap idempotente
// =====================================================
let schemaEnsured = false;

export async function ensureVoiceSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS call_logs (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        call_sid          TEXT NOT NULL UNIQUE,
        from_number       TEXT,
        to_number         TEXT,
        call_status       TEXT,
        started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at          TIMESTAMPTZ,
        duration_seconds  INTEGER,
        transcript        TEXT,
        ai_responses      TEXT,
        metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_call_logs_started ON call_logs (started_at DESC);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_call_logs_status  ON call_logs (call_status);`);
    await query(`
      CREATE TABLE IF NOT EXISTS call_turns (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        call_sid    TEXT NOT NULL,
        speaker     TEXT NOT NULL CHECK (speaker IN ('USER', 'AI', 'SYSTEM')),
        message     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_call_turns_call_sid ON call_turns (call_sid, created_at);`);
    schemaEnsured = true;
    logger.info("voice.schema.ensured");
  } catch (err) {
    logger.error({ err }, "voice.schema.ensure.failed");
    // No relanzamos: el arranque no debe fallar por esto en envs donde el
    // pgrole no tiene permisos de DDL. Las queries fallaran con mensaje claro
    // si la tabla no existe.
  }
}

// =====================================================
// Helpers privacy
// =====================================================

/** Enmascara un teléfono internacional para logs: +56912345678 -> +56*****5678 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "(unknown)";
  const clean = phone.replace(/\s+/g, "");
  if (clean.length <= 6) return clean;
  return `${clean.slice(0, 3)}${"*".repeat(Math.max(0, clean.length - 7))}${clean.slice(-4)}`;
}

// =====================================================
// CRUD calls
// =====================================================

/** Crea o devuelve la fila de call_logs para un callSid (upsert by call_sid). */
export async function startCallLog(
  tenantId: string,
  params: {
    callSid: string;
    fromNumber?: string | null;
    toNumber?: string | null;
    callStatus?: string | null;
  },
): Promise<CallLogRow> {
  const { rows } = await query<CallLogRow>(
    `
    INSERT INTO call_logs (tenant_id, call_sid, from_number, to_number, call_status)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (call_sid) DO UPDATE SET
      from_number = COALESCE(EXCLUDED.from_number, call_logs.from_number),
      to_number   = COALESCE(EXCLUDED.to_number,   call_logs.to_number),
      call_status = COALESCE(EXCLUDED.call_status, call_logs.call_status)
    WHERE call_logs.tenant_id = $1
    RETURNING *;
    `,
    [tenantId, params.callSid, params.fromNumber ?? null, params.toNumber ?? null, params.callStatus ?? "in-progress"]
  );
  return rows[0];
}

/** Update con campos opcionales: status, ended_at, duration, transcript append, ai_responses append. */
export async function updateCallLog(
  tenantId: string,
  callSid: string,
  patch: {
    callStatus?: string | null;
    endedAt?: Date | null;
    durationSeconds?: number | null;
    appendTranscript?: string;
    appendAiResponse?: string;
    mergeMetadata?: Record<string, unknown>;
  }
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (patch.callStatus !== undefined) {
    sets.push(`call_status = $${idx++}`); params.push(patch.callStatus);
  }
  if (patch.endedAt !== undefined) {
    sets.push(`ended_at = $${idx++}`); params.push(patch.endedAt);
  }
  if (patch.durationSeconds !== undefined) {
    sets.push(`duration_seconds = $${idx++}`); params.push(patch.durationSeconds);
  }
  if (patch.appendTranscript) {
    sets.push(`transcript = COALESCE(transcript, '') || $${idx++}`);
    params.push((patch.appendTranscript.endsWith("\n") ? patch.appendTranscript : patch.appendTranscript + "\n"));
  }
  if (patch.appendAiResponse) {
    sets.push(`ai_responses = COALESCE(ai_responses, '') || $${idx++}`);
    params.push((patch.appendAiResponse.endsWith("\n") ? patch.appendAiResponse : patch.appendAiResponse + "\n"));
  }
  if (patch.mergeMetadata) {
    sets.push(`metadata = metadata || $${idx++}::jsonb`); params.push(JSON.stringify(patch.mergeMetadata));
  }
  if (sets.length === 0) return;

  params.push(callSid);
  const callSidIdx = idx++;
  params.push(tenantId);
  const tenantIdx = idx;
  await query(
    `UPDATE call_logs SET ${sets.join(", ")} WHERE call_sid = $${callSidIdx} AND tenant_id = $${tenantIdx}`,
    params,
  );
}

export async function appendCallTurn(
  tenantId: string,
  callSid: string,
  speaker: CallSpeaker,
  message: string
): Promise<void> {
  const text = (message ?? "").trim();
  if (!text) return;
  await query(
    `INSERT INTO call_turns (tenant_id, call_sid, speaker, message) VALUES ($1, $2, $3, $4)`,
    [tenantId, callSid, speaker, text]
  );
}

export async function listCalls(tenantId: string, limit = 50): Promise<CallLogRow[]> {
  const safe = Math.max(1, Math.min(500, Math.floor(limit)));
  const { rows } = await query<CallLogRow>(
    `SELECT * FROM call_logs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [tenantId, safe]
  );
  return rows;
}

export async function getCallBySid(
  tenantId: string,
  callSid: string,
): Promise<{ call: CallLogRow | null; turns: CallTurnRow[] }> {
  const { rows: callRows } = await query<CallLogRow>(
    `SELECT * FROM call_logs WHERE tenant_id = $1 AND call_sid = $2 LIMIT 1`,
    [tenantId, callSid]
  );
  const call = callRows[0] ?? null;
  if (!call) return { call: null, turns: [] };
  const { rows: turns } = await query<CallTurnRow>(
    `SELECT * FROM call_turns WHERE tenant_id = $1 AND call_sid = $2 ORDER BY created_at ASC`,
    [tenantId, callSid]
  );
  return { call, turns };
}
