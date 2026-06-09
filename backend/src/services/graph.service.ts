// Knowledge graph (multi-tenant).
//
// MT-3: getKnowledgeGraph recibe tenantId. Nodos y edges se limitan a las
// entidades del tenant.
//
// Tipos de nodos: incident, ticket, conversation, kb, meeting.
// Tipos de edges: conversation→ticket (escalated), ticket→kb (uses_kb),
//                 kb→ticket (kb_from).
import { query } from "../database/db";

export type GraphNodeType = "incident" | "ticket" | "conversation" | "kb" | "meeting";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  subtitle?: string;
  href?: string;
  meta?: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: "escalated" | "uses_kb" | "kb_from" | "linked";
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: Record<GraphNodeType, number>;
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
