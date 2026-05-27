// Orquestador de la Mesa de Soporte.
// Pega: triage + resolver + decisión de escalación + persistencia.
//
// Flujo de cada mensaje del usuario:
//   1. Append message del usuario en support_messages.
//   2. Triage (Gemini JSON).
//   3. Resolver (Gemini con KB + RAG).
//   4. Append message del AI en support_messages.
//   5. Update conversation con triage + estado.
//   6. Si decision.should_escalate o triage.needs_escalation:
//        crear support_ticket con todo el contexto.
//        update conversation.status = 'escalated', escalated_to_ticket = <ticketId>.
//        agregar message del AI explicando que escaló.
//   7. Si decision.resolved: conversation.status='resolved', ai_resolved=true, closed_at=now.

import { logger } from "../../utils/logger";
import { emitEventFireAndForget } from "../integrations/delivery.service";
import {
  appendMessage, getConversationById, listMessages, updateConversation,
  recordSupportAudit,
} from "./conversation.service";
import { triageMessage, slaMinutesForUrgency, suggestedAssigneeRole } from "./triage.service";
import { resolveWithAi, QuotaExhaustedError } from "./resolver.service";
import { createTicket } from "./ticket.service";
import type {
  SupportConversation, SupportMessage, SupportTicket,
} from "../../types/support.types";

export interface HandleUserMessageResult {
  conversation: SupportConversation;
  aiMessage: SupportMessage;
  triage: {
    intent: string; sap_module: string; urgency: string; category: string;
    title: string; summary: string; confidence: string;
  };
  decision: {
    resolved: boolean; needs_more_info: boolean; should_escalate: boolean;
    kb_article_id: string | null;
  };
  kbHitsUsed: { id: string; title: string }[];
  escalatedTicket?: SupportTicket;
}

const GREETING = `¡Hola! 👋 Soy AMS-Bot, tu primera línea de soporte AMS Supply Chain SAP.
Cuéntame brevemente qué pasa y te ayudo. Si veo que el caso necesita un especialista, lo escalo a Nivel 2 con todo el contexto.`;

export async function handleFirstMessage(
  conversationId: string,
  userText: string
): Promise<HandleUserMessageResult> {
  // Append user message
  await appendMessage(conversationId, "user", userText);
  // Mandar saludo + procesar el primer mensaje (igual que un message normal)
  // El saludo lo añadimos como mensaje "system" para que el usuario lo vea pero
  // que el modelo no se confunda con conversación. En la UI se muestra arriba.
  await appendMessage(conversationId, "system", GREETING, { greeting: true });
  return handleUserMessageInternal(conversationId, userText);
}

export async function handleUserMessage(
  conversationId: string,
  userText: string
): Promise<HandleUserMessageResult> {
  await appendMessage(conversationId, "user", userText);
  return handleUserMessageInternal(conversationId, userText);
}

async function handleUserMessageInternal(
  conversationId: string,
  userText: string
): Promise<HandleUserMessageResult> {
  const conv = await getConversationById(conversationId);
  if (!conv) throw new Error("Conversación no encontrada");

  // 1. TRIAGE
  let triage;
  try {
    const history = await listMessages(conversationId);
    const recentText = history.slice(-6)
      .filter((m) => m.role === "user" || m.role === "ai")
      .map((m) => `${m.role === "user" ? "U" : "AI"}: ${m.text}`)
      .join("\n");
    triage = await triageMessage(userText, recentText);
  } catch (err) {
    logger.error({ err }, "support: triage fail, uso fallback");
    triage = {
      intent: "pregunta_general",
      sap_module: "NO_INFORMADO",
      urgency: "media" as const,
      category: "general",
      title: userText.slice(0, 80),
      summary: userText.slice(0, 280),
      missing_data: [],
      confidence: "baja" as const,
      needs_escalation: false,
    };
  }

  await recordSupportAudit({
    conversationId,
    action: "TRIAGE_DONE",
    actor: "ai",
    details: triage,
  });

  // 2. RESOLVER
  const history = await listMessages(conversationId);
  const transcript = history
    .filter((m) => m.role === "user" || m.role === "ai")
    .map((m) => ({ role: m.role, text: m.text ?? "" }));

  let result;
  try {
    result = await resolveWithAi({
      conversationHistory: transcript,
      triage,
      userClient: conv.client ?? undefined,
    });
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kind = (err as any)?.kind;
    if (err instanceof QuotaExhaustedError || kind === "quota_exhausted") {
      // Cuota Gemini agotada y sin KB que ayude. NO escalamos para no crear
      // tickets basura. El usuario verá un mensaje claro y la conversación
      // queda esperando que reintente.
      logger.warn({ conversationId }, "support: cuota Gemini agotada, no escalo");
      result = {
        responseText:
          "Disculpa, el asistente de IA está temporalmente al límite de cuota diaria del proveedor. " +
          "Por favor reintenta en unos minutos, o si es urgente puedes crear un ticket manualmente desde la sección **Tickets**.",
        decision: { resolved: false, needs_more_info: true, should_escalate: false, kb_article_id: null },
        kbHits: [],
        ragHits: 0,
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
      };
    } else {
      logger.error({ err }, "support: resolver fail");
      // Fallback genuino: error inesperado → escalamos
      result = {
        responseText: "Tuve un problema procesando tu consulta. Voy a escalar el caso a Nivel 2 para que te atiendan personalmente.",
        decision: { resolved: false, needs_more_info: false, should_escalate: true, kb_article_id: null },
        kbHits: [],
        ragHits: 0,
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
      };
    }
  }

  await recordSupportAudit({
    conversationId,
    action: result.kbHits.length > 0 ? "KB_HIT" : "AI_ANSWER",
    actor: "ai",
    details: {
      decision: result.decision,
      kbHits: result.kbHits.map((a) => ({ id: a.id, title: a.title })),
      ragHits: result.ragHits,
    },
  });

  // 3. Append AI message
  const aiMessage = await appendMessage(conversationId, "ai", result.responseText, {
    model: result.model,
    decision: result.decision,
    kbHits: result.kbHits.map((a) => ({ id: a.id, title: a.title })),
    ragHits: result.ragHits,
  });

  // 4. Actualizar triage en la conversación
  await updateConversation(conversationId, {
    intent: triage.intent,
    sap_module: triage.sap_module,
    urgency: triage.urgency,
    category: triage.category,
    summary: triage.summary,
    status: "ai_handling",
  });

  // 5. Decisión de escalación: SOLO si el resolver lo decidió. El triage
  // puede sugerir escalar pero el resolver es quien intenta y decide. Esto
  // evita escalar cuando la IA solo necesita más datos.
  const shouldEscalate = result.decision.should_escalate;
  let escalatedTicket: SupportTicket | undefined;

  if (shouldEscalate) {
    escalatedTicket = await escalateConversation(conversationId, triage, transcript);
    await appendMessage(
      conversationId,
      "system",
      `📤 Caso escalado a Nivel 2 con el ticket ${escalatedTicket.code}. Un especialista te contactará dentro de la SLA (${escalatedTicket.sla_minutes} min).`,
      { escalatedTicketId: escalatedTicket.id, ticketCode: escalatedTicket.code }
    );
  } else if (result.decision.resolved) {
    await updateConversation(conversationId, {
      status: "resolved",
      ai_resolved: true,
      closed_at: new Date().toISOString(),
    });
    await recordSupportAudit({
      conversationId,
      action: "CONV_RESOLVED_BY_AI",
      actor: "ai",
    });
  } else if (result.decision.needs_more_info) {
    await updateConversation(conversationId, { status: "waiting_user" });
  }

  const updated = await getConversationById(conversationId);
  return {
    conversation: updated!,
    aiMessage,
    triage: {
      intent: triage.intent,
      sap_module: triage.sap_module,
      urgency: triage.urgency,
      category: triage.category,
      title: triage.title,
      summary: triage.summary,
      confidence: triage.confidence,
    },
    decision: result.decision,
    kbHitsUsed: result.kbHits.map((a) => ({ id: a.id, title: a.title })),
    escalatedTicket,
  };
}

async function escalateConversation(
  conversationId: string,
  triage: Awaited<ReturnType<typeof triageMessage>>,
  transcript: { role: string; text: string }[]
): Promise<SupportTicket> {
  const conv = await getConversationById(conversationId);
  if (!conv) throw new Error("conv no encontrada");

  // Construir resumen + evidencias desde la conversación
  const transcriptText = transcript.map((m) => `${m.role === "user" ? "Usuario" : "AMS-Bot"}: ${m.text}`).join("\n");
  const evidences = [
    {
      type: "conversation",
      label: `Conversación completa (${transcript.length} mensajes)`,
      value: transcriptText.slice(0, 4000),
    },
    {
      type: "triage",
      label: "Resultado del triage IA",
      value: JSON.stringify(triage, null, 2),
    },
  ];
  if (conv.user_name) evidences.push({ type: "user", label: "Usuario", value: conv.user_name });
  if (conv.user_email) evidences.push({ type: "user", label: "Email", value: conv.user_email });
  if (conv.user_phone) evidences.push({ type: "user", label: "Teléfono", value: conv.user_phone });
  if (conv.client) evidences.push({ type: "client", label: "Cliente", value: conv.client });
  evidences.push({ type: "channel", label: "Canal", value: conv.channel });

  const ticket = await createTicket({
    conversationId,
    title: triage.title,
    summary: triage.summary,
    systemAffected: triage.sap_module,
    category: triage.category,
    priority: triage.urgency,
    slaMinutes: slaMinutesForUrgency(triage.urgency),
    assignedRole: suggestedAssigneeRole(triage.sap_module),
    evidences,
  });

  await updateConversation(conversationId, {
    status: "escalated",
    escalated_to_ticket: ticket.id,
  });

  await recordSupportAudit({
    conversationId,
    ticketId: ticket.id,
    action: "TICKET_CREATED",
    actor: "ai",
    details: {
      code: ticket.code,
      priority: ticket.priority,
      sla_minutes: ticket.sla_minutes,
      assigned_role: ticket.assigned_role,
      reason: triage.escalation_reason ?? null,
    },
  });

  // Emit hacia integraciones (Slack/Email/Webhook) — fire-and-forget
  emitEventFireAndForget("ticket.escalated", {
    code: ticket.code,
    title: ticket.title,
    summary: ticket.summary,
    priority: ticket.priority,
    sla_minutes: ticket.sla_minutes,
    sla_due_at: ticket.sla_due_at,
    system_affected: ticket.system_affected,
    category: ticket.category,
    assigned_role: ticket.assigned_role,
    conversation_id: conversationId,
    channel: conv.channel,
    user: conv.user_name,
    client: conv.client,
    reason: triage.escalation_reason ?? null,
  });

  return ticket;
}

export function welcomeText(): string {
  return GREETING;
}
