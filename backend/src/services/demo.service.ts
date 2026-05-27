// Auto-demo end-to-end: ejecuta un escenario completo de Mesa de Soporte
// (conversación → triage → escalación → asignación → resolución → KB) sin
// depender de Gemini, usando datos deterministas. Pensado para demos a clientes
// donde el agente real podría estar OOQ por cuota.
//
// Emite eventos vía AsyncGenerator que el controller convierte en SSE.
import { logger } from "../utils/logger";
import { createConversation, appendMessage, updateConversation } from "./support/conversation.service";
import { createTicket, setTicketStatus, resolveTicket } from "./support/ticket.service";
import { createArticle } from "./support/kb.service";
import { query } from "../database/db";

export interface DemoStep {
  step: number;
  total: number;
  kind:
    | "info" | "conversation_created" | "user_message" | "ai_triage"
    | "ai_message" | "ticket_created" | "ticket_assigned"
    | "ticket_resolved" | "kb_created" | "done" | "error";
  message: string;
  data?: Record<string, unknown>;
}

const TOTAL_STEPS = 9;

const SCENARIOS: { user: string; client: string; module: string; problem: string; solution: string }[] = [
  {
    user: "Cliente Demo",
    client: "demo",
    module: "MM",
    problem: "Tengo una orden de compra bloqueada por límite de tolerancia en MIRO, no la puedo liberar para pago. La OC es la 4500000123 del proveedor ACME.",
    solution: "1. Accede a MEK0 y revisa los límites de tolerancia activos para el grupo de tolerancia del usuario que genera la OC.\n2. Si la variación supera el tolerable, libera con OMR6 o ajusta los límites contractuales.\n3. Confirma con MR8M que el documento queda contabilizado.",
  },
  {
    user: "Cliente Demo",
    client: "demo",
    module: "SD",
    problem: "Mis pedidos de venta caen en bloqueo de crédito aunque el cliente tiene cupo. Revisé FD32 y aparece dentro del límite.",
    solution: "1. Verifica en F.31 si hay pedidos abiertos pesando contra el cupo (vencidos suman doble).\n2. Revisa la regla de control de crédito en OVA8 para la combinación área crédito + grupo riesgo.\n3. Si la regla es correcta, libera el bloqueo desde VKM3 y registra la justificación.",
  },
  {
    user: "Cliente Demo",
    client: "demo",
    module: "PP",
    problem: "MD04 no muestra los requerimientos de un material recién extendido. Ya activé MRP a nivel centro.",
    solution: "1. Revisa que el material tenga vista MRP1 con tipo MRP válido en MM03.\n2. Corre MD02 puntual para ese material para forzar la planificación.\n3. Si persiste, revisa OMI8 y la cobertura de horizontes del perfil de planificación.",
  },
];

function uid() { return Math.random().toString(36).slice(2, 8); }

async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

export async function* runDemoScenario(): AsyncGenerator<DemoStep, void, unknown> {
  const sc = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
  const code = `DEMO-${uid()}`;
  let step = 0;
  const next = (kind: DemoStep["kind"], message: string, data?: Record<string, unknown>): DemoStep => ({
    step: ++step, total: TOTAL_STEPS, kind, message, data,
  });

  try {
    yield next("info", `🎬 Iniciando escenario demo (${code}) — módulo ${sc.module} · cliente ${sc.client}`);
    await sleep(400);

    // 1. Conversación
    const conv = await createConversation({
      channel: "chat",
      user_name: sc.user,
      client: sc.client,
    });
    yield next("conversation_created", `💬 Conversación creada (${conv.id.slice(0, 8)}) en canal chat`, { conversationId: conv.id });
    await sleep(600);

    // 2. Mensaje del usuario
    await appendMessage(conv.id, "user", sc.problem);
    yield next("user_message", `👤 Usuario: "${sc.problem.slice(0, 90)}…"`);
    await sleep(900);

    // 3. Triage simulado
    const triage = {
      intent: "incidente",
      sap_module: sc.module,
      urgency: "alta" as const,
      category: "liberación / bloqueo",
      title: sc.problem.slice(0, 80),
      summary: sc.problem.slice(0, 260),
      missing_data: [],
      confidence: "alta" as const,
      needs_escalation: false,
    };
    await updateConversation(conv.id, {
      intent: triage.intent,
      sap_module: triage.sap_module,
      urgency: triage.urgency,
      category: triage.category,
      summary: triage.summary,
      status: "ai_handling",
    });
    yield next("ai_triage", `🧠 Triage IA: módulo=${triage.sap_module} · urgencia=${triage.urgency} · confianza=${triage.confidence}`, { triage });
    await sleep(800);

    // 4. Intento de respuesta IA
    const aiText = `Entiendo tu problema con ${triage.sap_module}. Necesito acceso al sistema para diagnosticarlo bien. Voy a escalar a Nivel 2 con todo el contexto.`;
    await appendMessage(conv.id, "ai", aiText, { demo: true });
    yield next("ai_message", `🤖 AMS-Bot: "${aiText}"`);
    await sleep(800);

    // 5. Escalación
    const ticket = await createTicket({
      conversationId: conv.id,
      title: triage.title,
      summary: triage.summary,
      systemAffected: triage.sap_module,
      category: triage.category,
      priority: triage.urgency,
      slaMinutes: 240,
      assignedRole: "consultor",
      evidences: [
        { type: "conversation", label: "Diálogo completo", value: sc.problem },
        { type: "triage", label: "Triage", value: JSON.stringify(triage, null, 2) },
      ],
    });
    await updateConversation(conv.id, { status: "escalated", escalated_to_ticket: ticket.id });
    await appendMessage(conv.id, "system", `📤 Caso escalado a Nivel 2 con el ticket ${ticket.code}.`, { escalatedTicketId: ticket.id });
    yield next("ticket_created", `🎫 Ticket creado: ${ticket.code} — prioridad ${ticket.priority}, SLA ${ticket.sla_minutes}min`, {
      ticketId: ticket.id, code: ticket.code, priority: ticket.priority,
    });
    await sleep(1000);

    // 6. Asignar a un agente (tomar el primer admin/consultor con users.role)
    const { rows: agents } = await query<{ id: string; name: string | null }>(
      `SELECT id, name FROM users WHERE role IN ('admin','consultor','aprobador') ORDER BY created_at LIMIT 1`
    );
    if (agents[0]) {
      const t = await setTicketStatus(ticket.id, "in_progress");
      yield next("ticket_assigned", `👨‍💻 Ticket asignado a ${agents[0].name ?? agents[0].id.slice(0,8)} (in_progress)`, {
        agentName: agents[0].name, status: t?.status,
      });
    } else {
      const t = await setTicketStatus(ticket.id, "in_progress");
      yield next("ticket_assigned", `👨‍💻 Ticket movido a in_progress`, { status: t?.status });
    }
    await sleep(900);

    // 7. Resolución
    const resolved = await resolveTicket(ticket.id, sc.solution);
    yield next("ticket_resolved", `✅ Ticket ${resolved?.code ?? ticket.code} resuelto`, { resolution: sc.solution.slice(0, 200) });
    await sleep(800);

    // 8. KB article (draft)
    const kb = await createArticle({
      title: `Solución: ${triage.title}`,
      problem: sc.problem,
      solution: sc.solution,
      system: sc.module,
      category: triage.category,
      tags: ["demo", sc.module.toLowerCase()],
      source: "from_ticket",
      source_ticket_id: ticket.id,
    });
    yield next("kb_created", `📘 KB article creado en draft: "${kb.title}" (id ${kb.id.slice(0, 8)})`, { kbId: kb.id });
    await sleep(600);

    // 9. Done
    yield next("done", `🎉 Demo completada — flujo end-to-end ejecutado en vivo.`, {
      conversationId: conv.id,
      ticketCode: ticket.code,
      kbId: kb.id,
    });
  } catch (err) {
    logger.error({ err }, "demo: scenario fail");
    yield {
      step, total: TOTAL_STEPS, kind: "error",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      message: `Error en el demo: ${(err as any)?.message ?? "desconocido"}`,
    };
  }
}
