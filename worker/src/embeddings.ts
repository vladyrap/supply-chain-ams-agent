import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger";
import { retryWithBackoff } from "./retry";

const MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const DIM = parseInt(process.env.GEMINI_EMBEDDING_DIM || "768", 10);

let client: GoogleGenAI | null = null;
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no definida");
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

interface EmbedResponse {
  embeddings?: { values?: number[] }[];
  // El SDK también puede devolver "embedding.values" según versión
  embedding?: { values?: number[] };
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const ai = getClient();
  // El método correcto en @google/genai 0.x para embeddings es:
  // ai.models.embedContent({ model, contents })
  // Acepta una lista en `contents`. Por seguridad iteramos por si la version no soporta batch.
  const out: number[][] = [];
  for (const t of texts) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: EmbedResponse = await retryWithBackoff(
        () => (ai.models as any).embedContent({
          model: MODEL,
          contents: t,
          config: { outputDimensionality: DIM },
        }),
        { label: "gemini.embedBatch", retries: 3 }
      );
      const vec =
        resp.embedding?.values ??
        resp.embeddings?.[0]?.values ??
        null;
      if (!vec || !Array.isArray(vec)) {
        throw new Error("Respuesta de embedding sin vector");
      }
      out.push(vec);
    } catch (err) {
      logger.error({ err }, "embed fail (un chunk)");
      throw err;
    }
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await embedBatch([text]);
  return v;
}
