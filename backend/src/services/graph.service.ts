// Knowledge graph (multi-tenant).
//
// MT-3: getKnowledgeGraph recibe tenantId. Nodos y edges se limitan a las
// entidades del tenant.
//
// Tipos de nodos: incident, ticket, conversation, kb, meeting.
// Tipos de edges: conversation→ticket (escalated), ticket→kb (uses_kb),
//                 kb→ticket (kb_from).
//
// ROCCO Fase 0 (activo #1): además de la proyección en vivo (getKnowledgeGraph),
// se PERSISTE el grafo en kg_node/kg_edge (rebuildKnowledgeGraph) y se puede leer
// persistido (getPersistedKnowledgeGraph). Ver docs/rocco/. La proyección en vivo
// queda intacta (backward-compatible).
import { createHash } from "crypto";
import { query, withTx } from "../database/db";
import { logger } from "../utils/logger";

// Tipos de nodo de la proyección viva (operacional). El grafo persistido admite
// además tipos SAP-técnicos (sap_object, sap_table, …) → GraphNode.type es string.
export type GraphNodeType = "incident" | "ticket" | "conversation" | "kb" | "meeting";

export interface GraphNode {
  id: string;
  type: string;   // GraphNodeType en la proyección viva; string admite nodos SAP-técnicos (Fase 2)
  label: string;
  subtitle?: string;
  href?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;   // escalated|uses_kb|kb_from|linked|accesses|remediated_by… (extensible)
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: Record<string, number>;
}

export async function getKnowledgeGraph(
  tenantId: string,
  opts: { limitPerType?: number } = {},
): Promise<GraphPayload> {
  const limit = Math.min(opts.limitPerType ?? 30, 100);

  const [incRows, tktRows, convRows, kbRows, meetRows] = await Promise.all([
    query<{ id: string; message: string; sap_module: string | null; client_name: string | null; created_at: string }>(
      `SELECT id, message, sap_module, client_name, created_at
         FROM incidents WHERE tenant_id = $2 ORDER BY created_at DESC LIMIT $1`,
      [limit, tenantId]
    ),
    query<{ id: string; code: string; title: string; status: string; conversation_id: string | null; kb_article_id: string | null; system_affected: string | null }>(
      `SELECT id, code, title, status, conversation_id, kb_article_id, system_affected
         FROM support_tickets WHERE tenant_id = $2 ORDER BY created_at DESC LIMIT $1`,
      [limit, tenantId]
    ),
    query<{ id: string; channel: string; intent: string | null; client: string | null; status: string; escalated_to_ticket: string | null }>(
      `SELECT id, channel, intent, client, status, escalated_to_ticket
         FROM support_conversations WHERE tenant_id = $2 ORDER BY created_at DESC LIMIT $1`,
      [limit, tenantId]
    ),
    query<{ id: string; title: string; system: string | null; status: string; source_ticket_id: string | null; helpful_count: number; use_count: number }>(
      `SELECT id, title, system, status, source_ticket_id, helpful_count, use_count
         FROM kb_articles WHERE tenant_id = $2 ORDER BY created_at DESC LIMIT $1`,
      [limit, tenantId]
    ),
    query<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM meetings WHERE tenant_id = $2 ORDER BY created_at DESC LIMIT $1`,
      [limit, tenantId]
    ),
  ]);

  const nodes: GraphNode[] = [];
  const presentIds = new Set<string>();

  for (const r of incRows.rows) {
    nodes.push({
      id: r.id,
      type: "incident",
      label: r.message.slice(0, 60),
      subtitle: [r.client_name, r.sap_module].filter(Boolean).join(" · "),
      href: `/history`,
      meta: { module: r.sap_module, client: r.client_name },
    });
    presentIds.add(r.id);
  }
  for (const r of tktRows.rows) {
    nodes.push({
      id: r.id,
      type: "ticket",
      label: r.code,
      subtitle: r.title.slice(0, 60),
      href: `/support-desk/tickets`,
      meta: { status: r.status, system: r.system_affected },
    });
    presentIds.add(r.id);
  }
  for (const r of convRows.rows) {
    nodes.push({
      id: r.id,
      type: "conversation",
      label: `${r.channel}: ${r.intent ?? "—"}`,
      subtitle: [r.client, r.status].filter(Boolean).join(" · "),
      href: `/support-desk/conversations`,
      meta: { status: r.status, channel: r.channel },
    });
    presentIds.add(r.id);
  }
  for (const r of kbRows.rows) {
    nodes.push({
      id: r.id,
      type: "kb",
      label: r.title.slice(0, 60),
      subtitle: [r.system ?? null, `${r.use_count} usos`, `${r.helpful_count} ❤`].filter(Boolean).join(" · "),
      href: `/support-desk/kb`,
      meta: { status: r.status, system: r.system },
    });
    presentIds.add(r.id);
  }
  for (const r of meetRows.rows) {
    nodes.push({
      id: r.id,
      type: "meeting",
      label: r.title.slice(0, 60),
      href: `/meetings`,
      meta: { status: r.status },
    });
    presentIds.add(r.id);
  }

  const edges: GraphEdge[] = [];

  for (const c of convRows.rows) {
    if (c.escalated_to_ticket && presentIds.has(c.escalated_to_ticket)) {
      edges.push({ from: c.id, to: c.escalated_to_ticket, kind: "escalated" });
    }
  }

  for (const t of tktRows.rows) {
    if (t.kb_article_id && presentIds.has(t.kb_article_id)) {
      edges.push({ from: t.id, to: t.kb_article_id, kind: "uses_kb" });
    }
  }

  for (const k of kbRows.rows) {
    if (k.source_ticket_id && presentIds.has(k.source_ticket_id)) {
      edges.push({ from: k.id, to: k.source_ticket_id, kind: "kb_from" });
    }
  }

  return {
    nodes,
    edges,
    counts: {
      incident: incRows.rows.length,
      ticket: tktRows.rows.length,
      conversation: convRows.rows.length,
      kb: kbRows.rows.length,
      meeting: meetRows.rows.length,
    },
  };
}

// ── ROCCO Fase 0 · Persistencia del Knowledge Graph ──────────────────────────
// Ver docs/rocco/ORGANIZATIONAL_MEMORY_AND_KNOWLEDGE_GRAPH.md. La proyección en
// vivo (getKnowledgeGraph) queda intacta; esto la MATERIALIZA de forma idempotente.

let kgSchemaEnsured = false;

/** Crea kg_node/kg_edge si no existen (idempotente; best-effort al arranque). */
export async function ensureKnowledgeGraphSchema(): Promise<void> {
  if (kgSchemaEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS kg_node (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
      label TEXT NOT NULL, subtitle TEXT, href TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
      content_hash TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, id)
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_kg_node_tenant_type ON kg_node (tenant_id, type);`);
  await query(`
    CREATE TABLE IF NOT EXISTS kg_edge (
      tenant_id TEXT NOT NULL, id TEXT NOT NULL,
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
      provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
      content_hash TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, id)
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_kg_edge_from ON kg_edge (tenant_id, from_id);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_kg_edge_to   ON kg_edge (tenant_id, to_id);`);
  kgSchemaEnsured = true;
  logger.info("kg.schema.ensured");
}

// Serialización estable (claves ordenadas) → content_hash reproducible (Evidence by Design).
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
function nodeHash(n: GraphNode): string {
  return sha256(stableStringify({ t: n.type, l: n.label, s: n.subtitle ?? "", h: n.href ?? "", m: n.meta ?? {} }));
}
function edgeId(e: GraphEdge): string {
  return sha256(`${e.from}|${e.kind}|${e.to}`);
}

export interface RebuildResult {
  nodes: number;
  edges: number;
  at: string;
}

/**
 * Recomputa la proyección y la MATERIALIZA en kg_node/kg_edge de forma idempotente:
 * upsert por (tenant_id,id) + reconciliación de stale (borra lo que ya no está en la
 * proyección). Multi-tenant, transaccional, con provenance. Recomputar no duplica.
 */
export async function rebuildKnowledgeGraph(tenantId: string): Promise<RebuildResult> {
  await ensureKnowledgeGraphSchema();
  const g = await getKnowledgeGraph(tenantId, { limitPerType: 100 });
  const at = new Date().toISOString();
  const prov = JSON.stringify({ origin: "system", source: "graph.projection", computed_at: at });

  await withTx(async (client) => {
    for (const n of g.nodes) {
      await client.query(
        `INSERT INTO kg_node (tenant_id,id,type,label,subtitle,href,meta,provenance,content_hash,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9, now())
         ON CONFLICT (tenant_id,id) DO UPDATE SET
           type=EXCLUDED.type, label=EXCLUDED.label, subtitle=EXCLUDED.subtitle, href=EXCLUDED.href,
           meta=EXCLUDED.meta, provenance=EXCLUDED.provenance, content_hash=EXCLUDED.content_hash,
           last_seen_at=now()`,
        [tenantId, n.id, n.type, n.label, n.subtitle ?? null, n.href ?? null,
         JSON.stringify(n.meta ?? {}), prov, nodeHash(n)]
      );
    }
    for (const e of g.edges) {
      const id = edgeId(e);
      await client.query(
        `INSERT INTO kg_edge (tenant_id,id,from_id,to_id,kind,provenance,content_hash,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7, now())
         ON CONFLICT (tenant_id,id) DO UPDATE SET
           from_id=EXCLUDED.from_id, to_id=EXCLUDED.to_id, kind=EXCLUDED.kind,
           provenance=EXCLUDED.provenance, content_hash=EXCLUDED.content_hash, last_seen_at=now()`,
        [tenantId, id, e.from, e.to, e.kind, prov, id]
      );
    }
    // Reconciliación de stale: borra lo que ya no está en la proyección de este tenant.
    const nodeIds = g.nodes.map((n) => n.id);
    const edgeIds = g.edges.map(edgeId);
    await client.query(`DELETE FROM kg_node WHERE tenant_id=$1 AND NOT (id = ANY($2::text[]))`, [tenantId, nodeIds]);
    await client.query(`DELETE FROM kg_edge WHERE tenant_id=$1 AND NOT (id = ANY($2::text[]))`, [tenantId, edgeIds]);
  });

  logger.info({ tenantId, nodes: g.nodes.length, edges: g.edges.length }, "kg.rebuilt");
  return { nodes: g.nodes.length, edges: g.edges.length, at };
}

/** Lee el grafo PERSISTIDO (kg_node/kg_edge) devolviendo el mismo GraphPayload. */
export async function getPersistedKnowledgeGraph(
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<GraphPayload> {
  await ensureKnowledgeGraphSchema();
  const limit = Math.min(opts.limit ?? 500, 2000);
  const [nodeRows, edgeRows] = await Promise.all([
    query<{ id: string; type: string; label: string; subtitle: string | null; href: string | null; meta: Record<string, string | number | boolean | null> }>(
      `SELECT id,type,label,subtitle,href,meta FROM kg_node WHERE tenant_id=$1 ORDER BY last_seen_at DESC LIMIT $2`,
      [tenantId, limit]
    ),
    query<{ from_id: string; to_id: string; kind: string }>(
      `SELECT from_id,to_id,kind FROM kg_edge WHERE tenant_id=$1 LIMIT $2`,
      [tenantId, limit * 4]
    ),
  ]);
  const nodes: GraphNode[] = nodeRows.rows.map((r) => ({
    id: r.id, type: r.type, label: r.label,
    subtitle: r.subtitle ?? undefined, href: r.href ?? undefined, meta: r.meta ?? {},
  }));
  const present = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = edgeRows.rows
    .filter((e) => present.has(e.from_id) && present.has(e.to_id))
    .map((e) => ({ from: e.from_id, to: e.to_id, kind: e.kind }));
  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
  return { nodes, edges, counts };
}

/**
 * Upsert idempotente de nodos/aristas al grafo persistido, SIN reconciliación de
 * stale (a diferencia de rebuildKnowledgeGraph): estos vienen de una fuente
 * EXTERNA (p. ej. el connector Clean Core) que no posee el conjunto completo.
 * provenance.source identifica la fuente. Recomputar no duplica.
 */
export async function upsertKgNodes(
  tenantId: string, nodes: GraphNode[], edges: GraphEdge[], source: string,
): Promise<{ nodes: number; edges: number }> {
  await ensureKnowledgeGraphSchema();
  if (nodes.length === 0 && edges.length === 0) return { nodes: 0, edges: 0 };
  const prov = JSON.stringify({ origin: "system", source, computed_at: new Date().toISOString() });
  await withTx(async (client) => {
    for (const n of nodes) {
      await client.query(
        `INSERT INTO kg_node (tenant_id,id,type,label,subtitle,href,meta,provenance,content_hash,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9, now())
         ON CONFLICT (tenant_id,id) DO UPDATE SET
           type=EXCLUDED.type, label=EXCLUDED.label, subtitle=EXCLUDED.subtitle, href=EXCLUDED.href,
           meta=EXCLUDED.meta, provenance=EXCLUDED.provenance, content_hash=EXCLUDED.content_hash, last_seen_at=now()`,
        [tenantId, n.id, n.type, n.label, n.subtitle ?? null, n.href ?? null,
         JSON.stringify(n.meta ?? {}), prov, nodeHash(n)]
      );
    }
    for (const e of edges) {
      const id = edgeId(e);
      await client.query(
        `INSERT INTO kg_edge (tenant_id,id,from_id,to_id,kind,provenance,content_hash,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7, now())
         ON CONFLICT (tenant_id,id) DO UPDATE SET
           from_id=EXCLUDED.from_id, to_id=EXCLUDED.to_id, kind=EXCLUDED.kind,
           provenance=EXCLUDED.provenance, content_hash=EXCLUDED.content_hash, last_seen_at=now()`,
        [tenantId, id, e.from, e.to, e.kind, prov, id]
      );
    }
  });
  return { nodes: nodes.length, edges: edges.length };
}
