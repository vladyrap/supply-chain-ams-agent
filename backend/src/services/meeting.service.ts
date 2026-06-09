import { Queue } from "bullmq";
import IORedis from "ioredis";
import { query } from "../database/db";
import { logger } from "../utils/logger";

// MT-2 (multi-tenant): meetings ahora se aíslan por tenant_id.
// El job de la cola lleva tenantId para que el worker pueda hacer
// updates scoped al mismo tenant que creó la reunión.

const REDIS_URL = process.env.REDIS_URL || "redis://supply-chain-ams-redis:6379";

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on("error", (err) => logger.error({ err }, "meeting.queue redis error"));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const meetingQueue = new Queue("meeting-process", { connection: connection as any });

export interface MeetingRecord {
  id: string;
  title: string;
  client: string | null;
  status: string;
  error_message: string | null;
  duration_sec: number | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  transcript: string | null;
  summary: string | null;
  minute: unknown;
  actions_text: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface CreateMeetingInput {
  title: string;
  client?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
  language?: string;
  userId?: string;
}

export async function createMeetingAndQueue(tenantId: string, input: CreateMeetingInput): Promise<MeetingRecord> {
  const { rows } = await query<MeetingRecord>(
    `INSERT INTO meetings
       (tenant_id, title, client, status, file_name, mime_type, size_bytes, created_by)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)
     RETURNING id, title, client, status, error_message, duration_sec, file_name, mime_type,
               size_bytes, transcript, summary, minute, actions_text, created_at, processed_at`,
    [
      tenantId,
      input.title,
      input.client ?? null,
      input.fileName,
      input.mimeType,
      input.sizeBytes,
      input.userId ?? null,
    ]
  );
  const meeting = rows[0]!;
  await meetingQueue.add(
    "process",
    {
      tenantId,
      meetingId: meeting.id,
      fileName: input.fileName,
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
      language: input.language ?? "es",
    },
    { removeOnComplete: 50, removeOnFail: 100 }
  );
  return meeting;
}

// Para el listado NO devolvemos transcript ni minute completos (pueden pesar).
const LIST_SELECT = `
  id, title, client, status, error_message, duration_sec, file_name, mime_type, size_bytes,
  CASE WHEN transcript IS NULL THEN NULL ELSE substring(transcript, 1, 200) END AS transcript,
  summary, minute, actions_text, created_at, processed_at
`;

export async function listMeetings(tenantId: string): Promise<MeetingRecord[]> {
  const { rows } = await query<MeetingRecord>(
    `SELECT ${LIST_SELECT} FROM meetings WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [tenantId]
  );
  return rows;
}

export async function getMeetingById(tenantId: string, id: string): Promise<MeetingRecord | null> {
  const { rows } = await query<MeetingRecord>(
    `SELECT id, title, client, status, error_message, duration_sec, file_name, mime_type, size_bytes,
            transcript, summary, minute, actions_text, created_at, processed_at
       FROM meetings WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  return rows[0] ?? null;
}

export async function deleteMeeting(tenantId: string, id: string): Promise<boolean> {
  const res = await query(`DELETE FROM meetings WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return res.rowCount > 0;
}
