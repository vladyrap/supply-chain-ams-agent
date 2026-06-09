import { logger } from "../logger";
import { query } from "../db";
import { detectSourceType, extractText, type SourceType } from "../extract";
import { chunkText } from "../chunker";
import { embedBatch } from "../embeddings";

export interface IngestJobData {
  documentId: string;
  fileName: string;
  mimeType: string;
  /** base64 del archivo original */
  dataBase64: string;
  module?: string;
  process?: string;
  client?: string;
  title?: string;
  /** FIX G4 (audit MT v1.2.0): tenant_id obligatorio para aislamiento RAG.
   *  Si no viene en el job payload, fallback a 'default' (legacy single-tenant). */
  tenantId?: string;
}

export async function processIngest(data: IngestJobData): Promise<void> {
  const { documentId, fileName, mimeType, dataBase64 } = data;
  const tenantId = data.tenantId || "default";
  if (!data.tenantId) {
    logger.warn({ documentId, fileName }, "ingest job sin tenantId — fallback 'default' (job payload viejo?)");
  }

  const type = detectSourceType(mimeType, fileName) as SourceType | null;
  if (!type) {
    await markError(documentId, `Formato no soportado: ${mimeType} (${fileName})`);
    return;
  }

  try {
    await markStatus(documentId, "processing");
    const buffer = Buffer.from(dataBase64, "base64");
    logger.info({ documentId, fileName, type, bytes: buffer.length }, "extract start");
    const text = await extractText(buffer, type);
    if (!text || text.length < 30) {
      await markError(documentId, "Texto extraído vacío o demasiado corto");
      return;
    }

    const chunks = chunkText(text);
    logger.info({ documentId, chunks: chunks.length }, "chunked");

    // Embeddings en serie (el SDK gratuito de Gemini tiene rate limit; iteramos suave)
    const texts = chunks.map((c) => c.content);
    const vectors = await embedBatch(texts);

    // Insert chunks
    let totalTokens = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const v = vectors[i];
      totalTokens += c.estimatedTokens;
      // FIX G4: tenant_id en INSERT para aislamiento RAG real
      await query(
        `INSERT INTO knowledge_items
           (tenant_id, document_id, title, source_type, source_file, module, process, client,
            chunk_index, content, tokens, embedding, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, 'indexed')`,
        [
          tenantId,
          documentId,
          data.title ?? fileName,
          type,
          fileName,
          data.module ?? null,
          data.process ?? null,
          data.client ?? null,
          c.index,
          c.content,
          c.estimatedTokens,
          `[${v.join(",")}]`,
        ]
      );
    }

    await query(
      `UPDATE knowledge_documents
          SET status = 'indexed',
              chunk_count = $1,
              total_tokens = $2,
              indexed_at = now(),
              error_message = NULL
        WHERE id = $3`,
      [chunks.length, totalTokens, documentId]
    );
    logger.info({ documentId, chunks: chunks.length, tokens: totalTokens }, "ingest OK");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, documentId }, "ingest fail");
    await markError(documentId, msg.slice(0, 500));
  }
}

async function markStatus(id: string, status: string) {
  await query(`UPDATE knowledge_documents SET status = $1 WHERE id = $2`, [status, id]);
}
async function markError(id: string, message: string) {
  await query(
    `UPDATE knowledge_documents SET status = 'error', error_message = $1 WHERE id = $2`,
    [message, id]
  );
}
