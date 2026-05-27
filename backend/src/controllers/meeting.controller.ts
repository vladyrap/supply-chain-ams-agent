import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  createMeetingAndQueue,
  listMeetings,
  getMeetingById,
  deleteMeeting,
} from "../services/meeting.service";
import { getUserBySession } from "../services/auth.service";

const ALLOWED_MIME = new Set<string>([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/wave", "audio/x-wav",
  "audio/webm", "audio/ogg", "audio/mp4", "audio/m4a", "audio/x-m4a",
]);
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

interface UploadBody {
  title?: string;
  client?: string;
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
  language?: string;
}

async function getUserId(req: FastifyRequest): Promise<string | null> {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.["ams_session"];
  if (!token) return null;
  const user = await getUserBySession(token);
  return user?.id ?? null;
}

export async function postUpload(
  req: FastifyRequest<{ Body: UploadBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.title) return reply.code(400).send({ success: false, error: "title es obligatorio" });
  if (!b.fileName) return reply.code(400).send({ success: false, error: "fileName es obligatorio" });
  if (!b.mimeType || !ALLOWED_MIME.has(b.mimeType.toLowerCase())) {
    return reply.code(400).send({
      success: false,
      error: "Tipo de audio no soportado. Acepta mp3, wav, m4a, webm, ogg.",
    });
  }
  if (!b.dataBase64) return reply.code(400).send({ success: false, error: "dataBase64 es obligatorio" });
  const approxBytes = Math.floor((b.dataBase64.length * 3) / 4);
  if (approxBytes > MAX_BYTES) {
    return reply.code(400).send({
      success: false,
      error: `Archivo supera el máximo de ${MAX_BYTES / (1024 * 1024)} MB`,
    });
  }

  try {
    const userId = await getUserId(req);
    const meeting = await createMeetingAndQueue({
      title: b.title.trim(),
      client: b.client?.trim() || undefined,
      fileName: b.fileName,
      mimeType: b.mimeType.toLowerCase(),
      sizeBytes: approxBytes,
      dataBase64: b.dataBase64,
      language: b.language || "es",
      userId: userId ?? undefined,
    });
    return reply.send({ success: true, meeting });
  } catch (err) {
    logger.error({ err }, "fallo en /api/meetings/upload");
    return reply.code(500).send({ success: false, error: "Error procesando la carga" });
  }
}

export async function getMeetings(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const meetings = await listMeetings();
    return reply.send({ success: true, count: meetings.length, meetings });
  } catch (err) {
    logger.error({ err }, "Fallo listando meetings");
    return reply.code(500).send({ success: false, error: "Error listando reuniones" });
  }
}

export async function getMeeting(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return reply.code(400).send({ success: false, error: "ID inválido" });
  }
  try {
    const row = await getMeetingById(id);
    if (!row) return reply.code(404).send({ success: false, error: "Reunión no encontrada" });
    return reply.send({ success: true, meeting: row });
  } catch (err) {
    logger.error({ err }, "Fallo obteniendo meeting");
    return reply.code(500).send({ success: false, error: "Error obteniendo reunión" });
  }
}

export async function delMeeting(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return reply.code(400).send({ success: false, error: "ID inválido" });
  }
  try {
    const ok = await deleteMeeting(id);
    if (!ok) return reply.code(404).send({ success: false, error: "no encontrada" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "Fallo borrando meeting");
    return reply.code(500).send({ success: false, error: "Error borrando reunión" });
  }
}
