import { Queue } from "bullmq";
import IORedis from "ioredis";
import { query } from "../database/db";
import { logger } from "../utils/logger";

const REDIS_URL = process.env.REDIS_URL || "redis://supply-chain-ams-redis:6379";

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
connection.on("error", (err) => logger.error({ err }, "knowledge.queue redis error"));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ingestQueue = new Queue("knowledge-ingest", { connection: connection as any });

export interface KnowledgeDocument {
  id: string;
  title: string | null;
  source_file: string | null;
  source_type: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  module: string | null;
  process: string | null;
  client: string | null;
  status: string;
  error_message: string | null;
  chunk_count: number;
  total_tokens: number;
  created_at: string;
  indexed_at: string | null;
}

export interface CreateDocumentInput {
  title?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
  module?: string;
  process?: string;
  client?: string;
}

export async function createDocumentAndQueue(input: CreateDocumentInput): Promise<KnowledgeDocument> {
  // Source type tentativo desde el mime
  let sourceType = "unknown";
  if (input.mimeType === "application/pdf") sourceType = "pdf";
  else if (input.mimeType.includes("wordprocessingml")) sourceType = "docx";
  else if (input.mimeType.includes("spreadsheetml")) sourceType = "xlsx";
  else if (input.mimeType === "text/markdown" || input.fileName.toLowerCase().endsWith(".md")) sourceType = "md";
  else if (input.mimeType.startsWith("text/")) sourceType = "txt";

  const { rows } = await query<KnowledgeDocument>(
    `INSERT INTO knowledge_documents
       (title, source_file, source_type, mime_type, size_bytes, module, process, client, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     RETURNING *`,
    [
      input.title ?? input.fileName,
      input.fileName,
      sourceType,
      input.mimeType,
      input.sizeBytes,
      input.module ?? null,
      input.process ?? null,
      input.client ?? null,
    ]
  );
  const doc = rows[0]!;
  await ingestQueue.add(
    "ingest",
    {
      documentId: doc.id,
      fileName: input.fileName,
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
      module: input.module,
      process: input.process,
      client: input.client,
      title: input.title ?? input.fileName,
    },
    { removeOnComplete: 100, removeOnFail: 200 }
  );
  return doc;
}

export async function listDocuments(filters: { module?: string; client?: string; status?: string } = {}): Promise<KnowledgeDocument[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.module) { params.push(filters.module); conds.push(`module = $${params.length}`); }
  if (filters.client) { params.push(filters.client); conds.push(`client = $${params.length}`); }
  if (filters.status) { params.push(filters.status); conds.push(`status = $${params.length}`); }
  const whereSql = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { rows } = await query<KnowledgeDocument>(
    `SELECT * FROM knowledge_documents ${whereSql} ORDER BY created_at DESC LIMIT 200`,
    params
  );
  return rows;
}

export async function deleteDocument(id: string): Promise<boolean> {
  // CASCADE en knowledge_items por FK
  const res = await query(`DELETE FROM knowledge_documents WHERE id = $1`, [id]);
  return res.rowCount > 0;
}

export interface KnowledgeStats {
  documents: number;
  documentsIndexed: number;
  documentsPending: number;
  documentsError: number;
  chunks: number;
  totalTokens: number;
}

export async function getKnowledgeStats(): Promise<KnowledgeStats> {
  const [docs, chunks] = await Promise.all([
    query<{ status: string; c: string; tk: string }>(
      `SELECT status, count(*)::text AS c, COALESCE(sum(total_tokens),0)::text AS tk
         FROM knowledge_documents GROUP BY status`
    ),
    query<{ c: string }>(`SELECT count(*)::text AS c FROM knowledge_items`),
  ]);
  let total = 0, indexed = 0, pending = 0, error = 0, tokens = 0;
  for (const r of docs.rows) {
    const c = Number(r.c);
    total += c;
    tokens += Number(r.tk);
    if (r.status === "indexed") indexed += c;
    else if (r.status === "error") error += c;
    else pending += c;
  }
  return {
    documents:         total,
    documentsIndexed:  indexed,
    documentsPending:  pending,
    documentsError:    error,
    chunks:            Number(chunks.rows[0]?.c ?? 0),
    totalTokens:       tokens,
  };
}
