// =============================================================
// Búsqueda semántica unificada (multi-tenant).
// =============================================================
// Mantiene una tabla search_index que consolida entidades de varios
// tipos. Se actualiza vía:
//   - reindexAll(tenantId): pasa por todas las entidades del tenant, indexa
//   - upsertOne(tenantId, item): cuando se crea/edita una entidad
//
// MT-3: search_index tiene columna tenant_id (migration 005). Todas las
// queries filtran por tenant para aislar los corpus entre clientes.
// =============================================================
import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { retryWithBackoff } from "../utils/retry";

const EMBED_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBED_DIM = parseInt(process.env.GEMINI_EMBEDDING_DIM || "768", 10);

let ai: GoogleGenAI | null = null;
function getAi(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");
  if (!ai) ai = new GoogleGenAI({ apiKey });
  return ai;
}

async function embed(text: string): Promise<number[]> {
  const client = getAi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp: any = await retryWithBackoff(
    () => (client.models as any).embedContent({
      model: EMBED_MODEL,
      contents: text,
      config: { outputDimensionality: EMBED_DIM },
    }),
    { label: "search.embed", retries: 2 }
  );
  const vec = resp.embedding?.values ?? resp.embeddings?.[0]?.values ?? null;
  if (!vec) throw new Error("respuesta de embedding inválida");
  return vec as number[];
}

// ============================================================
// Upsert
// ============================================================
export type SearchSourceType = "incident" | "ticket" | "conversation" | "kb" | "meeting" | "inbound";

export interface UpsertSearchItem {
  source_type: SearchSourceType;
  source_id: string;
  title: string;
  excerpt: string;
  href: string;
  metadata?: Record<string, unknown>;
}

export async function upsertSearch(tenantId: string, item: UpsertSearchItem): Promise<void> {
  const textToEmbed = `${item.title}\n${item.excerpt}`.slice(0, 4000);
  if (!textToEmbed.trim()) return;
  let vec: number[];
  try {
    vec = await embed(textToEmbed);
  } catch (err) {
    logger.warn({ err, source: `${item.source_type}:${item.source_id}` }, "search.upsert: embed fail");
    return;
  }
  await query(
    `INSERT INTO search_index
       (tenant_id, source_type, source_id, title, excerpt, href, metadata, embedding, indexed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::vector, now())
     ON CONFLICT (tenant_id, source_type, source_id) DO UPDATE
       SET title = EXCLUDED.title,
           excerpt = EXCLUDED.excerpt,
           href = EXCLUDED.href,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding,
           indexed_at = now()`,
    [
      tenantId,
      item.source_type,
      item.source_id,
      item.title,
      item.excerpt,
      item.href,
      JSON.stringify(item.metadata ?? {}),
      `[${vec.join(",")}]`,
    ]
  );
}

// Fire-and-forget para usar desde los flujos de negocio sin bloquear
export function upsertSearchFireAndForget(tenantId: string, item: UpsertSearchItem): void {
  upsertSearch(tenantId, item).catch((err) => {
    logger.warn({ err }, "search.upsert fire-and-forget unhandled");
  });
}

// ============================================================
// Reindex completo: pasa por todas las entidades del tenant y las upserte
// ============================================================
export interface ReindexResult {
  ok: number;
  failed: number;
  byType: Record<SearchSourceType, number>;
}

export async function reindexAll(tenantId: string, opts: { force?: boolean } = {}): Promise<ReindexResult> {
  const stats: ReindexResult = {
    ok: 0, failed: 0,
    byType: { incident: 0, ticket: 0, conversation: 0, kb: 0, meeting: 0, inbound: 0 },
  };
  const tryUpsert = async (item: UpsertSearchItem) => {
    if (!opts.force) {
      // Skip si ya está indexado y es reciente (< 7 días) — scoped al tenant
      const existing = await query<{ indexed_at: string }>(
        `SELECT indexed_at FROM search_index
           WHERE tenant_id = $1 AND source_type = $2 AND source_id = $3`,
        [tenantId, item.source_type, item.source_id]
      );
      if (existing.rows[0]) {
        const age = Date.now() - new Date(existing.rows[0].indexed_at).getTime();
        if (age < 7 * 24 * 60 * 60 * 1000) return; // skip
      }
    }
    try {
      await upsertSearch(tenantId, item);
      stats.ok++;
      stats.byType[item.source_type]++;
    } catch (err) {
      stats.failed++;
      logger.warn({ err, source: `${item.source_type}:${item.source_id}` }, "reindex item fail");
    }
  };

  // === incidents (scoped) ===
  const incidents = await query<{ id: string; message: string; response: string | null; sap_module: string | null; client_name: string | null; confidence: string | null }>(
    `SELECT id, message, response, sap_module, client_name, confidence
       FROM incidents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [tenantId]
  );
  for (const r of incidents.rows) {
    await tryUpsert({
      source_type: "incident",
      source_id: r.id,
      title: r.message.slice(0, 120),
      excerpt: (r.response ?? "").slice(0, 800),
      href: "/history",
      metadata: { module: r.sap_module, client: r.client_name, confidence: r.confidence },
    });
  }

  // === tickets de mesa (scoped) ===
  const tickets = await query<{ id: string; code: string; title: string; summary: string; system_affected: string | null; priority: string; status: string }>(
    `SELECT id, code, title, summary, system_affected, priority, status
       FROM support_tickets WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 500`,
    [tenantId]
  );
  for (const r of tickets.rows) {
    await tryUpsert({
      source_type: "ticket",
      source_id: r.id,
      title: `${r.code} — ${r.title}`,
      excerpt: r.summary,
      href: "/support-desk/tickets",
      metadata: { code: r.code, system: r.system_affected, priority: r.priority, status: r.status },
    });
  }

  // === conversations (Mesa) (scoped) ===
  const convs = await query<{ id: string; sap_module: string | null; summary: string | null; user_name: string | null; channel: string; status: string }>(
    `SELECT id, sap_module, summary, user_name, channel, status
       FROM support_conversations
       WHERE tenant_id = $1 AND summary IS NOT NULL
       ORDER BY updated_at DESC LIMIT 500`,
    [tenantId]
  );
  for (const r of convs.rows) {
    await tryUpsert({
      source_type: "conversation",
      source_id: r.id,
      title: `Conv ${r.user_name ?? "anónimo"} (${r.channel})`,
      excerpt: r.summary ?? "",
      href: "/support-desk/conversations",
      metadata: { module: r.sap_module, status: r.status, channel: r.channel },
    });
  }

  // === KB articles (scoped) ===
  const kbs = await query<{ id: string; title: string; problem: string; solution: string; system: string | null; category: string | null; status: string }>(
    `SELECT id, title, problem, solution, system, category, status
       FROM kb_articles WHERE tenant_id = $1 AND status = 'approved'
       ORDER BY created_at DESC LIMIT 500`,
    [tenantId]
  );
  for (const r of kbs.rows) {
    await tryUpsert({
      source_type: "kb",
      source_id: r.id,
      title: r.title,
      excerpt: r.problem.slice(0, 400) + " // " + r.solution.slice(0, 400),
      href: "/support-desk/kb",
      metadata: { system: r.system, category: r.category },
    });
  }

  // === meetings (scoped) ===
  const meetings = await query<{ id: string; title: string; summary: string | null; client: string | null }>(
    `SELECT id, title, summary, client
       FROM meetings WHERE tenant_id = $1 AND status = 'done'
       ORDER BY created_at DESC LIMIT 200`,
    [tenantId]
  );
  for (const r of meetings.rows) {
    await tryUpsert({
      source_type: "meeting",
      source_id: r.id,
      title: r.title,
      excerpt: (r.summary ?? "").slice(0, 800),
      href: "/meetings",
      metadata: { client: r.client },
    });
  }

  // === SAP inbound (scoped) ===
  const inb = await query<{ id: string; title: string; summary: string | null; source: string; sap_system: string | null }>(
    `SELECT id, title, summary, source, sap_system
       FROM sap_inbound_events WHERE tenant_id = $1
       ORDER BY created_at DESC LIMIT 200`,
    [tenantId]
  );
  for (const r of inb.rows) {
    await tryUpsert({
      source_type: "inbound",
      source_id: r.id,
      title: `[${r.source}] ${r.title}`,
      excerpt: (r.summary ?? "").slice(0, 600),
      href: "/integrations/sap-inbound",
      metadata: { sap_source: r.source, sap_system: r.sap_system },
    });
  }

  return stats;
}

// ============================================================
// Search
// ============================================================
export interface SearchHit {
  source_type: SearchSourceType;
  source_id: string;
  title: string;
  excerpt: string;
  href: string;
  metadata: Record<string, unknown>;
  score: number;
}

export async function semanticSearch(opts: {
  tenantId: string;
  query: string;
  limit?: number;
  types?: SearchSourceType[];
}): Promise<SearchHit[]> {
  const q = opts.query.trim();
  if (!q) return [];
  const limit = Math.min(opts.limit ?? 20, 50);

  // ¿Hay items indexados para este tenant?
  const { rows: cntRows } = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM search_index
      WHERE tenant_id = $1 AND embedding IS NOT NULL`,
    [opts.tenantId]
  );
  if (Number(cntRows[0]?.c ?? 0) === 0) return [];

  let vec: number[];
  try {
    vec = await embed(q);
  } catch (err) {
    logger.warn({ err }, "search: embed query fail");
    return [];
  }

  const conds: string[] = ["tenant_id = $1", "embedding IS NOT NULL"];
  const params: unknown[] = [opts.tenantId];
  if (opts.types && opts.types.length > 0) {
    params.push(opts.types);
    conds.push(`source_type = ANY($${params.length}::text[])`);
  }
  params.push(`[${vec.join(",")}]`);
  const vecParam = `$${params.length}`;
  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await query<{
    source_type: string; source_id: string; title: string; excerpt: string;
    href: string; metadata: unknown; distance: number;
  }>(
    `SELECT source_type, source_id, title, excerpt, href, metadata,
            (embedding <=> ${vecParam}::vector) AS distance
       FROM search_index
       WHERE ${conds.join(" AND ")}
       ORDER BY embedding <=> ${vecParam}::vector
       LIMIT ${limitParam}`,
    params
  );

  return rows.map((r) => ({
    source_type: r.source_type as SearchSourceType,
    source_id: r.source_id,
    title: r.title,
    excerpt: r.excerpt,
    href: r.href,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    score: 1 - Number(r.distance),
  })).filter((h) => h.score > 0.1);  // descartar matches débiles
}

export async function getSearchStats(tenantId: string): Promise<{ total: number; byType: Record<string, number>; lastIndexed: string | null }> {
  const { rows: total } = await query<{ c: string }>(
    "SELECT count(*)::text AS c FROM search_index WHERE tenant_id = $1",
    [tenantId]
  );
  const { rows: byType } = await query<{ source_type: string; c: string }>(
    "SELECT source_type, count(*)::text AS c FROM search_index WHERE tenant_id = $1 GROUP BY source_type",
    [tenantId]
  );
  const { rows: latest } = await query<{ d: string }>(
    "SELECT max(indexed_at)::text AS d FROM search_index WHERE tenant_id = $1",
    [tenantId]
  );
  const byTypeMap: Record<string, number> = {};
  for (const r of byType) byTypeMap[r.source_type] = Number(r.c);
  return {
    total: Number(total[0]?.c ?? 0),
    byType: byTypeMap,
    lastIndexed: latest[0]?.d ?? null,
  };
}
