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

// =====================================================
// Quick-add: ingest text directly (no file)
// =====================================================
export interface IngestTextInput {
  title: string;
  content: string;
  module?: string;
  client?: string;
}

export async function ingestTextDirect(input: IngestTextInput): Promise<KnowledgeDocument> {
  // Sintetizamos un "documento" tipo md con el texto pegado, igual va al worker
  // como mime text/markdown para reusar el path de ingesta normal.
  const fileName = `${input.title.replace(/[^a-zA-Z0-9_\-]+/g, "_").slice(0, 60) || "pasted"}.md`;
  const dataBase64 = Buffer.from(input.content, "utf-8").toString("base64");
  return createDocumentAndQueue({
    title: input.title,
    fileName,
    mimeType: "text/markdown",
    sizeBytes: Buffer.byteLength(input.content, "utf-8"),
    dataBase64,
    module: input.module,
    client: input.client,
  });
}

// =====================================================
// URL ingest — descarga HTML/Markdown desde URL y lo encola
// =====================================================
export interface IngestUrlInput {
  url: string;
  title?: string;
  module?: string;
  client?: string;
}

const MAX_URL_BYTES = 8 * 1024 * 1024; // 8MB
const FETCH_TIMEOUT_MS = 15_000;

/** Extrae texto razonable de HTML quitando script/style/comments/tags. */
function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function ingestFromUrl(input: IngestUrlInput): Promise<KnowledgeDocument> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("URL inválida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Solo http/https soportado");
  }
  // Defensa básica contra SSRF a redes privadas comunes
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("169.254.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
    host === "0.0.0.0"
  ) {
    throw new Error("Hosts privados no permitidos");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "ams-agent-ingest/1.0", Accept: "text/html, application/pdf, text/markdown, text/plain;q=0.9, */*;q=0.5" },
    });
  } catch (err) {
    throw new Error(`No se pudo descargar la URL: ${err instanceof Error ? err.message : "error desconocido"}`);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} al descargar la URL`);
  }
  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  const buf = await resp.arrayBuffer();
  if (buf.byteLength === 0) throw new Error("Respuesta vacía");
  if (buf.byteLength > MAX_URL_BYTES) throw new Error("Archivo demasiado grande (>8MB)");

  // ---------- Caso PDF: encolamos el binario crudo, el worker hace el extract ----------
  const looksLikePdf =
    contentType.includes("pdf") ||
    url.pathname.toLowerCase().endsWith(".pdf") ||
    // PDF magic bytes %PDF
    (buf.byteLength >= 4 && Buffer.from(buf.slice(0, 4)).toString("ascii") === "%PDF");
  if (looksLikePdf) {
    let title = input.title?.trim();
    if (!title) {
      const last = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
      title = decodeURIComponent(last).replace(/\.pdf$/i, "").slice(0, 160) || url.hostname;
    }
    const dataBase64 = Buffer.from(buf).toString("base64");
    return createDocumentAndQueue({
      title,
      fileName: title.replace(/[^a-zA-Z0-9_\-]+/g, "_").slice(0, 60) + ".pdf",
      mimeType: "application/pdf",
      sizeBytes: buf.byteLength,
      dataBase64,
      module: input.module,
      client: input.client,
    });
  }

  // ---------- Caso texto / HTML / MD ----------
  if (!contentType.startsWith("text/") && !contentType.includes("json") && !contentType.includes("markdown") && contentType !== "") {
    throw new Error(`Content-Type no soportado: ${contentType}`);
  }

  const raw = Buffer.from(buf).toString("utf-8");
  const isHtml = contentType.includes("html") || /<html|<body|<div/i.test(raw.slice(0, 2000));
  const text = isHtml ? htmlToText(raw) : raw;

  if (text.length < 20) {
    throw new Error("No se pudo extraer texto significativo de la URL");
  }

  // Intentar extraer título de <title> si el usuario no dio uno
  let title = input.title?.trim();
  if (!title && isHtml) {
    const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) title = m[1].replace(/\s+/g, " ").trim().slice(0, 160);
  }
  if (!title) title = url.hostname + url.pathname;

  // Reusa el path de ingestText (encolado al worker)
  const header = `# ${title}\n\n_Fuente: ${url.toString()}_\n\n`;
  return ingestTextDirect({
    title,
    content: header + text.slice(0, 200_000),
    module: input.module,
    client: input.client,
  });
}

// =====================================================
// Chunks por documento
// =====================================================
export interface DocumentChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  module: string | null;
  client: string | null;
  source_file: string;
  source_type: string;
  estimated_tokens: number;
}

export async function listChunksByDocument(documentId: string, limit = 200): Promise<DocumentChunk[]> {
  const safe = Math.max(1, Math.min(500, limit));
  const { rows } = await query<DocumentChunk>(
    `SELECT id, document_id, chunk_index, content, module, client, source_file, source_type,
            COALESCE(estimated_tokens, 0)::int AS estimated_tokens
       FROM knowledge_items
       WHERE document_id = $1 AND status = 'indexed'
       ORDER BY chunk_index ASC
       LIMIT $2`,
    [documentId, safe]
  );
  return rows;
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
