import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";
import { logger } from "../utils/logger";

const EMBED_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBED_DIM = parseInt(process.env.GEMINI_EMBEDDING_DIM || "768", 10);
const TOP_K = parseInt(process.env.RAG_TOP_K || "6", 10);
const MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE || "0.55");
const RAG_ENABLED = (process.env.RAG_ENABLED || "true").toLowerCase() === "true";

let client: GoogleGenAI | null = null;
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

async function embed(text: string): Promise<number[]> {
  const ai = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp: any = await (ai.models as any).embedContent({
    model: EMBED_MODEL,
    contents: text,
    config: { outputDimensionality: EMBED_DIM },
  });
  const vec = resp.embedding?.values ?? resp.embeddings?.[0]?.values ?? null;
  if (!vec) throw new Error("respuesta de embedding inválida");
  return vec as number[];
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  title: string;
  sourceType: string;
  sourceFile: string;
  module: string | null;
  client: string | null;
  chunkIndex: number;
  content: string;
  score: number;
}

interface RetrieveFilters {
  module?: string;
  client?: string;
}

export async function retrieveRelevantChunks(
  questionText: string,
  filters: RetrieveFilters = {}
): Promise<RetrievedChunk[]> {
  if (!RAG_ENABLED) return [];
  if (!questionText.trim()) return [];

  // ¿Hay items indexados? Evita query vectorial sobre tabla vacía.
  const { rows: countRows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM knowledge_items WHERE status = 'indexed' AND embedding IS NOT NULL`
  );
  const total = Number(countRows[0]?.c ?? 0);
  if (total === 0) return [];

  let vec: number[];
  try {
    vec = await embed(questionText);
  } catch (err) {
    logger.warn({ err }, "RAG: embed de query falló, sigo sin contexto");
    return [];
  }

  // Filtros opcionales. Usamos cosine distance (1 - similarity).
  const conds: string[] = ["status = 'indexed'", "embedding IS NOT NULL"];
  const params: unknown[] = [];
  if (filters.module && filters.module !== "NO_INFORMADO") {
    params.push(filters.module);
    conds.push(`(module IS NULL OR module = $${params.length})`);
  }
  if (filters.client && filters.client !== "NO_INFORMADO") {
    params.push(filters.client);
    conds.push(`(client IS NULL OR client = $${params.length})`);
  }
  params.push(`[${vec.join(",")}]`);
  const vecParam = `$${params.length}`;
  params.push(TOP_K);
  const limitParam = `$${params.length}`;

  const { rows } = await query<{
    id: string; document_id: string; title: string; source_type: string; source_file: string;
    module: string | null; client: string | null; chunk_index: number; content: string;
    distance: number;
  }>(
    `SELECT id, document_id, title, source_type, source_file, module, client,
            chunk_index, content,
            (embedding <=> ${vecParam}::vector) AS distance
       FROM knowledge_items
       WHERE ${conds.join(" AND ")}
       ORDER BY embedding <=> ${vecParam}::vector
       LIMIT ${limitParam}`,
    params
  );

  // Convertir distancia cosine [0..2] → score [1..-1]; filtrar por MIN_SCORE.
  const chunks: RetrievedChunk[] = rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    title: r.title,
    sourceType: r.source_type,
    sourceFile: r.source_file,
    module: r.module,
    client: r.client,
    chunkIndex: r.chunk_index,
    content: r.content,
    score: 1 - Number(r.distance),
  }));

  // v0.13 — Priority boost por tipo de documento ANTES del filter+sort.
  // playbook > caso histórico > knowledge base > scope item > otros
  const boosted = chunks
    .filter((c) => c.score >= MIN_SCORE)
    .map((c) => ({ ...c, score: c.score * priorityBoost(c.sourceType) }))
    .sort((a, b) => b.score - a.score);

  return boosted;
}

/** Boost multiplicativo por tipo de fuente (G-F6). */
function priorityBoost(sourceType: string | null | undefined): number {
  if (!sourceType) return 1.0;
  const norm = sourceType.toLowerCase();
  if (norm.includes("playbook")) return 2.0;
  if (norm.includes("historical_case") || norm.includes("case")) return 1.5;
  if (norm.includes("knowledge") || norm === "kb") return 1.2;
  if (norm.includes("scope")) return 1.0;
  return 0.9; // otros tipos (manual upload, etc.) — leve penalty
}

export function formatContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  const parts: string[] = [
    "[CONTEXTO RAG — fragmentos recuperados de la base de conocimiento interna]",
    "Úsalos como evidencia cuando aporten, y cita la fuente entre corchetes al final del bloque",
    "correspondiente (ej. [fuente: blueprint-mm.pdf, chunk 3]).",
    "Si la respuesta no se apoya en el contexto, dilo y responde con conocimiento general.",
    "",
  ];
  chunks.forEach((c, i) => {
    parts.push(`--- Fragmento ${i + 1} (score=${c.score.toFixed(2)}, ${c.sourceFile}, chunk ${c.chunkIndex}) ---`);
    parts.push(c.content);
    parts.push("");
  });
  return parts.join("\n");
}
