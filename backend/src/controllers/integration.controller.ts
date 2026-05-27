import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  createDestination, listDestinations, getDestinationById,
  updateDestination, deleteDestination,
} from "../services/integrations/destinations.service";
import {
  testDestination, listDeliveries, emitEvent,
} from "../services/integrations/delivery.service";
import { getUserBySession } from "../services/auth.service";
import { KNOWN_EVENTS } from "../types/integration.types";
import type {
  DestinationType, DestinationConfig, WebhookConfig, SlackConfig, EmailConfig,
  SapConfig, SapAdapter,
} from "../types/integration.types";

const VALID_SAP_ADAPTERS: ReadonlySet<SapAdapter> = new Set<SapAdapter>([
  "cloud_alm", "s4_odata", "btp_workflow", "idoc_http", "solman",
]);

const COOKIE = "ams_session";

async function getUserId(req: FastifyRequest): Promise<string | null> {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const token = cookies?.[COOKIE];
  if (!token) return null;
  const u = await getUserBySession(token);
  return u?.id ?? null;
}

function validateConfig(type: DestinationType, cfg: unknown): { ok: true; cfg: DestinationConfig } | { ok: false; error: string } {
  if (!cfg || typeof cfg !== "object") return { ok: false, error: "config inválida" };
  const c = cfg as Record<string, unknown>;
  if (type === "webhook") {
    if (typeof c.url !== "string" || !/^https?:\/\//.test(c.url)) return { ok: false, error: "webhook.url debe ser http(s)" };
    return { ok: true, cfg: { url: c.url, headers: c.headers as Record<string, string> | undefined, secret: c.secret as string | undefined } as WebhookConfig };
  }
  if (type === "slack") {
    if (typeof c.webhookUrl !== "string" || !/^https:\/\/hooks\.slack\.com\//.test(c.webhookUrl)) {
      return { ok: false, error: "slack.webhookUrl debe ser https://hooks.slack.com/..." };
    }
    return { ok: true, cfg: { webhookUrl: c.webhookUrl, channel: c.channel as string | undefined } as SlackConfig };
  }
  if (type === "email") {
    const to = c.to;
    if (!Array.isArray(to) || to.length === 0 || !to.every((x) => typeof x === "string" && x.includes("@"))) {
      return { ok: false, error: "email.to debe ser lista de direcciones válidas" };
    }
    return { ok: true, cfg: { to, from: c.from as string | undefined, subject_prefix: c.subject_prefix as string | undefined } as EmailConfig };
  }
  if (type === "sap") {
    if (typeof c.adapter !== "string" || !VALID_SAP_ADAPTERS.has(c.adapter as SapAdapter)) {
      return { ok: false, error: "sap.adapter debe ser: cloud_alm | s4_odata | btp_workflow | idoc_http | solman" };
    }
    if (typeof c.baseUrl !== "string" || !/^https?:\/\//.test(c.baseUrl)) {
      return { ok: false, error: "sap.baseUrl debe ser http(s)" };
    }
    if (typeof c.path !== "string" || c.path.length === 0) {
      return { ok: false, error: "sap.path es obligatorio" };
    }
    const auth = c.auth as string;
    if (!["basic", "bearer", "oauth2_client_credentials", "none"].includes(auth)) {
      return { ok: false, error: "sap.auth debe ser: basic | bearer | oauth2_client_credentials | none" };
    }
    return {
      ok: true,
      cfg: {
        adapter: c.adapter as SapAdapter,
        baseUrl: c.baseUrl as string,
        path: c.path as string,
        auth: auth as SapConfig["auth"],
        username: c.username as string | undefined,
        password: c.password as string | undefined,
        bearerToken: c.bearerToken as string | undefined,
        oauthTokenUrl: c.oauthTokenUrl as string | undefined,
        oauthClientId: c.oauthClientId as string | undefined,
        oauthClientSecret: c.oauthClientSecret as string | undefined,
        sapClient: c.sapClient as string | undefined,
        headers: c.headers as Record<string, string> | undefined,
        fetchCsrf: c.fetchCsrf as boolean | undefined,
        bodyTemplate: c.bodyTemplate as string | undefined,
      } as SapConfig,
    };
  }
  return { ok: false, error: "tipo no soportado" };
}

// =========================================================
// CRUD destinations
// =========================================================
interface CreateDestBody {
  name?: string;
  type?: DestinationType;
  config?: unknown;
  event_filter?: string[];
  active?: boolean;
}

export async function postCreateDestination(
  req: FastifyRequest<{ Body: CreateDestBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.name || !b.type) return reply.code(400).send({ success: false, error: "name y type son obligatorios" });
  if (!["webhook", "slack", "email", "sap"].includes(b.type)) {
    return reply.code(400).send({ success: false, error: "type debe ser webhook | slack | email | sap" });
  }
  const v = validateConfig(b.type, b.config);
  if (!v.ok) return reply.code(400).send({ success: false, error: v.error });
  try {
    const me = await getUserId(req);
    const d = await createDestination({
      name: b.name,
      type: b.type,
      config: v.cfg,
      event_filter: b.event_filter,
      active: b.active ?? true,
      created_by: me ?? undefined,
    });
    return reply.send({ success: true, destination: d });
  } catch (err) {
    logger.error({ err }, "create destination fail");
    return reply.code(500).send({ success: false, error: "Error creando destination" });
  }
}

export async function getDestinations(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const list = await listDestinations();
    return reply.send({ success: true, count: list.length, destinations: list });
  } catch (err) {
    logger.error({ err }, "list destinations fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function getDestinationDetail(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const d = await getDestinationById(req.params.id);
    if (!d) return reply.code(404).send({ success: false, error: "no encontrada" });
    return reply.send({ success: true, destination: d });
  } catch (err) {
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

interface UpdateBody {
  name?: string;
  config?: unknown;
  event_filter?: string[];
  active?: boolean;
}

export async function patchDestination(
  req: FastifyRequest<{ Params: { id: string }; Body: UpdateBody }>,
  reply: FastifyReply
) {
  try {
    const existing = await getDestinationById(req.params.id);
    if (!existing) return reply.code(404).send({ success: false, error: "no encontrada" });
    const b = req.body || {};
    let cfgValidated: DestinationConfig | undefined;
    if (b.config !== undefined) {
      const v = validateConfig(existing.type, b.config);
      if (!v.ok) return reply.code(400).send({ success: false, error: v.error });
      cfgValidated = v.cfg;
    }
    const d = await updateDestination(req.params.id, {
      name: b.name,
      config: cfgValidated,
      event_filter: b.event_filter,
      active: b.active,
    });
    return reply.send({ success: true, destination: d });
  } catch (err) {
    logger.error({ err }, "update destination fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function delDestination(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const ok = await deleteDestination(req.params.id);
    if (!ok) return reply.code(404).send({ success: false, error: "no encontrada" });
    return reply.send({ success: true });
  } catch (err) {
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function postTestDestination(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const result = await testDestination(req.params.id);
    return reply.send({ success: true, result });
  } catch (err) {
    logger.error({ err }, "test destination fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

// =========================================================
// Deliveries
// =========================================================
interface DeliveriesQuery {
  destinationId?: string;
  status?: "pending" | "sent" | "failed";
  eventType?: string;
}

export async function getDeliveries(
  req: FastifyRequest<{ Querystring: DeliveriesQuery }>,
  reply: FastifyReply
) {
  try {
    const data = await listDeliveries({
      destinationId: req.query.destinationId,
      status: req.query.status,
      eventType: req.query.eventType,
    });
    return reply.send({ success: true, count: data.length, deliveries: data });
  } catch (err) {
    logger.error({ err }, "list deliveries fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

// =========================================================
// Emit manual (admin)
// =========================================================
interface EmitBody { eventType?: string; data?: Record<string, unknown> }

export async function postEmit(
  req: FastifyRequest<{ Body: EmitBody }>,
  reply: FastifyReply
) {
  const b = req.body || {};
  if (!b.eventType) return reply.code(400).send({ success: false, error: "eventType obligatorio" });
  try {
    await emitEvent(b.eventType, b.data ?? {});
    return reply.send({ success: true });
  } catch (err) {
    logger.error({ err }, "emit fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

// =========================================================
// Catálogo de eventos conocidos
// =========================================================
export async function getKnownEvents(_req: FastifyRequest, reply: FastifyReply) {
  return reply.send({
    success: true,
    events: KNOWN_EVENTS.map((e) => ({
      name: e,
      description: EVENT_DESCRIPTIONS[e] ?? "",
    })),
  });
}

const EVENT_DESCRIPTIONS: Record<string, string> = {
  "ticket.escalated": "La Mesa de Soporte escaló un caso a Nivel 2 creando un ticket MESA-NNNN.",
  "ticket.resolved":  "Nivel 2 marcó como resuelto un ticket de la Mesa de Soporte.",
  "ticket.closed":    "Un ticket MESA fue cerrado definitivamente.",
  "meeting.done":     "El worker terminó de transcribir y extraer minuta de una reunión.",
  "incident.created": "Nuevo incidente registrado en el chat del Agente AMS.",
  "kb.created":       "Se creó un artículo de KB curada (draft).",
  "kb.approved":      "Un artículo de KB fue aprobado por Nivel 2.",
  "test":             "Evento de prueba disparado desde la UI.",
};
