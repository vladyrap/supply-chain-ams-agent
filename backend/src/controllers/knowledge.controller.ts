import type { FastifyRequest, FastifyReply } from "fastify";
import { ValidationError } from "../utils/errors";
import { logger } from "../utils/logger";
import {
  createDocumentAndQueue,
  listDocuments,
  deleteDocument,
  getKnowledgeStats,
} from "../services/knowledge.service";

interface IngestBody {
  fileName?: string;
  mimeType?: string;
  dataBase64?: string;
  title?: string;
  module?: string;
  process?: string;
  client?: string;
}

const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/markdown",
  "text/plain",
]);
const MAX_BYTES = 15 * 1024 * 1024;  // 15 MB por documento

export async function postIngest(
  req: FastifyRequest<{ Body: IngestBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.fileName || typeof b.fileName !== "string") {
    return reply.code(400).send({ success: false, error: "fileName es obligatorio" });
  }
  if (!b.mimeType || typeof b.mimeType !== "string" || !ALLOWED_MIME.has(b.mimeType)) {
    return reply.code(400).send({
      success: false,
      error: "Tipo de archivo no soportado. Formatos: PDF, DOCX, XLSX, MD, TXT.",
    });
  }
  if (!b.dataBase64 || typeof b.dataBase64 !== "string") {
    return reply.code(400).send({ success: false, error: "dataBase64 es obligatorio" });
  }
  const approxBytes = Math.floor((b.dataBase64.length * 3) / 4);
  if (approxBytes > MAX_BYTES) {
    return reply.code(400).send({
      success: false,
      error: `Archivo supera el máximo de ${MAX_BYTES / (1024 * 1024)} MB`,
    });
  }

  try {
    const doc = await createDocumentAndQueue({
      title: b.title,
      fileName: b.fileName,
      mimeType: b.mimeType,
      sizeBytes: approxBytes,
      dataBase64: b.dataBase64,
      module: b.module,
      process: b.process,
      client: b.client,
    });
    return reply.send({ success: true, document: doc });
  } catch (err) {
    logger.error({ err }, "fallo en /api/knowledge/ingest");
    if (err instanceof ValidationError) {
      return reply.code(400).send({ success: false, error: err.publicMessage });
    }
    return reply.code(500).send({ success: false, error: "Error procesando la carga" });
  }
}

interface ListQuery { module?: string; client?: string; status?: string }

export async function getDocuments(
  req: FastifyRequest<{ Querystring: ListQuery }>,
  reply: FastifyReply
) {
  try {
    const q = req.query || {};
    const documents = await listDocuments({
      module: q.module || undefined,
      client: q.client || undefined,
      status: q.status || undefined,
    });
    return reply.send({ success: true, count: documents.length, documents });
  } catch (err) {
    logger.error({ err }, "Fallo listando knowledge documents");
    return reply.code(500).send({ success: false, error: "Error listando documentos" });
  }
}

export async function delDocument(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return reply.code(400).send({ success: false, error: "ID inválido" });
  }
  try {
    const ok = await deleteDocument(id);
    if (!ok) return reply.code(404).send({ success: false, error: "Documento no encontrado" });
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "Fallo borrando knowledge document");
    return reply.code(500).send({ success: false, error: "Error borrando documento" });
  }
}

export async function getKnowledgeOverview(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const stats = await getKnowledgeStats();
    return reply.send({ success: true, stats });
  } catch (err) {
    logger.error({ err }, "Fallo en knowledge stats");
    return reply.code(500).send({ success: false, error: "Error calculando overview" });
  }
}
