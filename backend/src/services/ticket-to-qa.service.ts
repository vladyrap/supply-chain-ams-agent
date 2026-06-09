// Tickets cerrados → Q&A propuestas.
//
// Pipeline:
//   1) Lee tickets resueltos / cerrados recientes que NO tengan Q&A
//      asociadas (vía source_ticket_id de algún kb_training_item con
//      Q&A, o por heurística simple: no hay Q&A cuyo conocimiento haga
//      referencia al ticket).
//   2) Para cada uno, le pasa a Gemini el ticket + su conversación y
//      le pide Q&A en JSON.
//   3) Si el ticket NO tiene un kb_training_item creado todavía, también
//      crea el item base como DRAFT con la info del ticket.
//   4) Inserta las Q&A en kb_training_qa con approved=false para que
//      el humano las revise y apruebe.
//
// Diseñado para ser corrido manualmente desde UI o por cron futuro.

import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { ConfigError } from "../utils/errors";
import { extractUsage } from "./usage.service";
import * as training from "./training.service";

const MODEL = "gemini-2.5-flash";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ConfigError("GEMINI_API_KEY no configurada");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

export interface TicketToQaReport {
  scannedAt: string;
  ticketsScanned: number;
  qasProposed: number;
  itemsCreated: number;
  skipped: number;
  byTicket: {
    ticketCode: string;
    ticketTitle: string;
    proposedQas: number;
    newItemCreated: boolean;
    error: string | null;
  }[];
}

interface TicketRow {
  id: string;
  code: string;
  title: string;
  summary: string;
  sap_module: string | null;
  conversation_id: string | null;
  client: string | null;
  resolved_at: string | null;
}

interface ProposedQA { question: string; expectedAnswer: string }
interface AiProposal {
  itemTitle?: string;
  itemSummary?: string;
  qas?: ProposedQA[];
}

const PROCESS_BY_MODULE: Record<string, string> = {
  MM: "Compras", SD: "Ventas", PP: "Planificación", FI: "Costos", CO: "Costos",
  EWM: "Almacén", QM: "Calidad", BTP: "Integraciones", AMS: "AMS Genérico",
};

async function askGeminiForQAs(ticket: TicketRow, transcript: string): Promise<AiProposal> {
  const ai = getClient();
  const prompt = `
Tenés que extraer Q&A para entrenar al agente AMS a partir de un ticket resuelto.

# TICKET
- Código: ${ticket.code}
- Título: ${ticket.title}
- Resumen: ${ticket.summary || "(sin resumen)"}
- Módulo SAP: ${ticket.sap_module || "no informado"}

# TRANSCRIPCIÓN
${transcript || "(sin conversación asociada)"}

# INSTRUCCIONES
Devolvé SOLO un JSON con esta forma exacta, sin markdown:
{
  "itemTitle": "Título corto del knowledge item base",
  "itemSummary": "Resumen accionable de 1-2 oraciones",
  "qas": [
    { "question": "...", "expectedAnswer": "..." },
    ...
  ]
}

Reglas:
- 3 a 6 Q&A. Variadas: una de síntoma, una de transacción SAP usada, una de workaround, etc.
- Preguntas en español, naturales (como las haría un usuario).
- expectedAnswer concisa pero específica, mencionando transacciones SAP cuando aplique.
- itemTitle máx 100 chars.
`.trim();

  try {
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        systemInstruction: "Sos un curador de KB AMS Supply Chain SAP. Devolvés SOLO JSON válido.",
        responseMimeType: "application/json",
        maxOutputTokens: 2048,
        temperature: 0.3,
      },
    });
    extractUsage(resp);
    const text = (resp.text ?? "").trim();
    try { return JSON.parse(text) as AiProposal; }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]) as AiProposal; } catch { /* */ } }
      return {};
    }
  } catch (err) {
    logger.warn({ err, ticket: ticket.code }, "ticket-to-qa Gemini fail");
    return {};
  }
}

export async function proposeQAsFromTickets(opts: {
  limit?: number;
  daysBack?: number;
} = {}): Promise<TicketToQaReport> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT));
  const daysBack = Math.max(1, Math.min(180, opts.daysBack ?? 30));

  // MT-2: cron sin contexto HTTP, usamos "default". TODO MT-6: parametrizar tenantId.
  const tenantId = "default";

  // Ensure schema (kb_training_*)
  await training.getSnapshot(tenantId).catch(() => null);

  // 1. Tickets resueltos sin Q&A asociadas (heurística: ticket sin kb item, o item sin Q&A)
  let tickets: TicketRow[] = [];
  try {
    const { rows } = await query<TicketRow>(
      `SELECT t.id, t.code, t.title, t.summary, t.sap_module, t.conversation_id, t.client, t.resolved_at
         FROM support_tickets t
        WHERE t.status IN ('resolved','closed')
          AND t.resolved_at > now() - ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM kb_training_items i
            WHERE i.source = 'from_ticket' OR i.source LIKE 'ticket #' || t.code || '%'
          )
        ORDER BY t.resolved_at DESC
        LIMIT $2`,
      [String(daysBack), limit]
    );
    tickets = rows;
  } catch (err) {
    logger.warn({ err }, "ticket-to-qa fetch tickets fail");
  }

  const report: TicketToQaReport = {
    scannedAt: new Date().toISOString(),
    ticketsScanned: tickets.length,
    qasProposed: 0,
    itemsCreated: 0,
    skipped: 0,
    byTicket: [],
  };

  for (const t of tickets) {
    let transcript = "";
    if (t.conversation_id) {
      try {
        const { rows } = await query<{ role: string; text: string }>(
          `SELECT role, COALESCE(text,'') AS text
             FROM support_messages
            WHERE conversation_id = $1
            ORDER BY created_at ASC LIMIT 60`,
          [t.conversation_id]
        );
        transcript = rows.map((m) => `[${m.role.toUpperCase()}] ${m.text}`).join("\n").slice(0, 6000);
      } catch { /* ignore */ }
    }

    const proposal = await askGeminiForQAs(t, transcript);
    if (!proposal.qas || proposal.qas.length === 0) {
      report.skipped++;
      report.byTicket.push({
        ticketCode: t.code, ticketTitle: t.title,
        proposedQas: 0, newItemCreated: false,
        error: "Gemini no devolvió Q&A válidas",
      });
      continue;
    }

    // Crear knowledge item base como DRAFT (humano valida después)
    try {
      const mod = t.sap_module || "AMS";
      const proc = PROCESS_BY_MODULE[mod.toUpperCase()] ?? "AMS Genérico";
      const newItem = await training.createItem(tenantId, {
        title: (proposal.itemTitle || `${mod} · ${t.title}`).slice(0, 200),
        content: `## Origen\nTicket ${t.code} — ${t.title}\n\n${transcript ? "## Transcripción base\n" + transcript.slice(0, 2000) : ""}`,
        summary: (proposal.itemSummary || t.summary || t.title).slice(0, 280),
        module: mod,
        process: proc,
        type: "INCIDENT_SOLUTION",
        source: `ticket #${t.code}`,
        tags: [mod, "ticket-import"],
        priority: "medium",
        status: "DRAFT",
        author: "ticket-to-qa",
      });
      report.itemsCreated++;

      // Crear Q&A pending (approved=false)
      await training.createQA(tenantId, proposal.qas.slice(0, 6).map((q) => ({
        knowledgeItemId: newItem.id,
        question: q.question?.slice(0, 500) ?? "",
        expectedAnswer: q.expectedAnswer?.slice(0, 2000) ?? "",
      })));
      report.qasProposed += proposal.qas.length;

      report.byTicket.push({
        ticketCode: t.code, ticketTitle: t.title,
        proposedQas: proposal.qas.length, newItemCreated: true,
        error: null,
      });
    } catch (err) {
      report.skipped++;
      report.byTicket.push({
        ticketCode: t.code, ticketTitle: t.title,
        proposedQas: 0, newItemCreated: false,
        error: err instanceof Error ? err.message : "error",
      });
    }
  }

  logger.info({ ...report, byTicket: undefined }, "ticket-to-qa run");
  return report;
}
