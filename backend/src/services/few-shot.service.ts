// Few-shot injection.
// Cuando llega un query al agente, este servicio busca:
//   - Q&A aprobadas (kb_training_qa.approved=true) relevantes
//   - KnowledgeItems PUBLISHED relevantes
// y arma un bloque markdown que se inyecta al system prompt como
// "ejemplos de comportamiento esperado". Esto convierte cada Q&A
// aprobada en entrenamiento real sin fine-tuning.
//
// Lógica de match: léxica (palabras clave compartidas con la query),
// con bonus por módulo SAP coincidente y filtro por status.
//
// Cache LRU simple por query hash + módulo (TTL 5 minutos) para no
// pegarle a Postgres en cada turno de una conversación larga.

import { query } from "../database/db";
import { logger } from "../utils/logger";

const TTL_MS = 5 * 60 * 1000;
const MAX_QAS = 3;
const MAX_ITEMS = 2;

interface CacheEntry {
  block: string;
  qaIds: string[];
  itemIds: string[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function tokenize(text: string): Set<string> {
  const STOP = new Set(["el","la","los","las","un","una","de","del","al","a","y","o","u","en","con","sin","por","para","que","se","es","ser","esta","esto","no","si","como","cuando","donde","que","cual","hace","hago","tengo","tiene","puede","puedo","the","of","to","and","in","on","at","for","with","by","is","are","was","were","be"]);
  return new Set(
    text.toLowerCase()
      .replace(/[^a-záéíóúñü0-9\s/_-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  a.forEach((t) => { if (b.has(t)) inter++; });
  return inter / (a.size + b.size - inter);
}

function hashKey(query: string, module?: string): string {
  return `${(module ?? "").toLowerCase()}::${query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200)}`;
}

export interface FewShotResult {
  /** Bloque markdown listo para concatenar al system prompt */
  block: string;
  qaIds: string[];
  itemIds: string[];
}

interface QARow {
  id: string;
  question: string;
  expected_answer: string;
  item_module: string | null;
  item_title: string | null;
  item_score: number | null;
  item_tags: string[] | null;
}

interface ItemRow {
  id: string;
  title: string;
  summary: string;
  module: string;
  score: number;
  tags: string[];
}

/**
 * Devuelve un bloque few-shot armado dinámicamente según el query del usuario.
 * Si no hay matches buenos, devuelve block vacío (no inyecta nada).
 *
 * Estrategia:
 *   1) Intenta búsqueda semántica con embeddings (kb_training_*_embeddings).
 *   2) Si no hay vectores indexados todavía, cae al match léxico Jaccard.
 */
export async function buildFewShotBlock(userQuery: string, module?: string): Promise<FewShotResult> {
  if (!userQuery || userQuery.trim().length < 3) {
    return { block: "", qaIds: [], itemIds: [] };
  }
  const key = hashKey(userQuery, module);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { block: cached.block, qaIds: cached.qaIds, itemIds: cached.itemIds };
  }

  // ---------- Intento semántico ----------
  try {
    const { buildSemanticFewShot } = await import("./training-embeddings.service");
    const sem = await buildSemanticFewShot(userQuery, module);
    if (sem.qas.length > 0 || sem.items.length > 0) {
      const lines: string[] = [];
      lines.push("", "---", "# 📚 CONOCIMIENTO CURADO RELEVANTE (entrenamiento humano)", "");
      lines.push("El equipo AMS aprobó los siguientes ejemplos para este tipo de consulta.");
      lines.push("Usalos como referencia. **NO inventes** transacciones SAP que no aparezcan aquí.", "");

      if (sem.items.length > 0) {
        lines.push("## Artículos relacionados (PUBLISHED)");
        sem.items.forEach((it) => {
          lines.push(`- **${it.title}** _(${it.module}, similitud ${(it.similarity * 100).toFixed(0)}%)_`);
          lines.push(`  ${it.summary}`);
        });
        lines.push("");
      }
      if (sem.qas.length > 0) {
        lines.push("## Q&A aprobadas (ejemplos de respuesta correcta)");
        sem.qas.forEach((q, i) => {
          lines.push(`### Ejemplo ${i + 1}${q.module ? ` · ${q.module}` : ""} _(similitud ${(q.similarity * 100).toFixed(0)}%)_`);
          lines.push(`**Pregunta del usuario:** ${q.question}`);
          lines.push("");
          lines.push(`**Respuesta esperada:**`);
          lines.push(q.expected_answer);
          lines.push("");
        });
      }
      lines.push("---", "");
      const result: FewShotResult = { block: lines.join("\n"), qaIds: sem.qaIds, itemIds: sem.itemIds };
      cache.set(key, { ...result, expiresAt: Date.now() + TTL_MS });
      return result;
    }
  } catch (err) {
    logger.debug({ err }, "semantic few-shot fail, fallback to lexical");
  }

  // ---------- Fallback léxico ----------
  const qTokens = tokenize(userQuery);
  if (qTokens.size === 0) {
    return { block: "", qaIds: [], itemIds: [] };
  }

  // 1) Q&A aprobadas (join con su item padre para módulo + score)
  let qas: QARow[] = [];
  try {
    const { rows } = await query<QARow>(
      `SELECT q.id, q.question, q.expected_answer,
              i.module AS item_module, i.title AS item_title, i.score AS item_score, i.tags AS item_tags
         FROM kb_training_qa q
         LEFT JOIN kb_training_items i ON i.id = q.knowledge_item_id
        WHERE q.approved = true
          AND (i.status IS NULL OR i.status NOT IN ('ARCHIVED','REJECTED'))
        ORDER BY q.created_at DESC
        LIMIT 200`
    );
    qas = rows;
  } catch (err) {
    logger.debug({ err }, "few-shot.qas fail (tabla no existe todavía?)");
  }

  // 2) Knowledge items PUBLISHED
  let items: ItemRow[] = [];
  try {
    const { rows } = await query<ItemRow>(
      `SELECT id, title, summary, module, score, tags
         FROM kb_training_items
        WHERE status = 'PUBLISHED'
        ORDER BY score DESC
        LIMIT 100`
    );
    items = rows;
  } catch (err) {
    logger.debug({ err }, "few-shot.items fail");
  }

  // ----- ranking Q&A -----
  const scoredQas = qas.map((q) => {
    const qTok = tokenize(q.question + " " + q.expected_answer);
    let s = jaccard(qTokens, qTok);
    if (module && q.item_module === module) s += 0.15;
    if (q.item_tags?.some((t) => qTokens.has(t.toLowerCase()))) s += 0.05;
    if (q.item_score && q.item_score >= 85) s += 0.05;
    return { q, s };
  })
    .filter((x) => x.s >= 0.08)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_QAS);

  // ----- ranking items -----
  const scoredItems = items.map((it) => {
    const itTok = tokenize(it.title + " " + it.summary + " " + (it.tags ?? []).join(" "));
    let s = jaccard(qTokens, itTok);
    if (module && it.module === module) s += 0.15;
    if (it.tags?.some((t) => qTokens.has(t.toLowerCase()))) s += 0.05;
    s += Math.max(0, (it.score - 70) / 200); // micro-boost por score alto
    return { it, s };
  })
    .filter((x) => x.s >= 0.08)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_ITEMS);

  if (scoredQas.length === 0 && scoredItems.length === 0) {
    const empty = { block: "", qaIds: [], itemIds: [] };
    cache.set(key, { ...empty, expiresAt: Date.now() + TTL_MS });
    return empty;
  }

  // ----- componer block markdown -----
  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("# 📚 CONOCIMIENTO CURADO RELEVANTE (entrenamiento humano)");
  lines.push("");
  lines.push("El equipo AMS aprobó los siguientes ejemplos y conocimientos para este tipo de consulta.");
  lines.push("Usalos como referencia de la respuesta esperada. **NO inventes** transacciones SAP que no aparezcan aquí.");
  lines.push("");

  if (scoredItems.length > 0) {
    lines.push("## Artículos relacionados (PUBLISHED)");
    scoredItems.forEach((x) => {
      lines.push(`- **${x.it.title}** _(${x.it.module}, score ${x.it.score})_`);
      lines.push(`  ${x.it.summary}`);
    });
    lines.push("");
  }

  if (scoredQas.length > 0) {
    lines.push("## Q&A aprobadas (ejemplos de respuesta correcta)");
    scoredQas.forEach((x, i) => {
      lines.push(`### Ejemplo ${i + 1}${x.q.item_module ? ` · ${x.q.item_module}` : ""}`);
      lines.push(`**Pregunta del usuario:** ${x.q.question}`);
      lines.push("");
      lines.push(`**Respuesta esperada:**`);
      lines.push(x.q.expected_answer);
      lines.push("");
    });
  }

  lines.push("---");
  lines.push("");

  const block = lines.join("\n");
  const result: FewShotResult = {
    block,
    qaIds: scoredQas.map((x) => x.q.id),
    itemIds: scoredItems.map((x) => x.it.id),
  };
  cache.set(key, { ...result, expiresAt: Date.now() + TTL_MS });
  return result;
}

/** Invalidar todo el cache (p.ej. cuando se aprueba una Q&A nueva o se publica un item). */
export function invalidateFewShotCache(): void {
  cache.clear();
}
