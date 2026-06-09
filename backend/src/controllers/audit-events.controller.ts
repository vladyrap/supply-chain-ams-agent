// =============================================================================
// audit-events.controller.ts — handlers para Audit Trail rico (DH v0.9)
// =============================================================================

import type { FastifyReply, FastifyRequest } from "fastify";
import {
  recordAuditEvent, listAuditEvents, getAuditByTicket, getAuditSummary,
} from "../services/audit-events.service";
import type {
  AuditEventInput, AuditEventFilters,
} from "../types/audit-events.types";
import { logger } from "../utils/logger";

/**
 * GET /api/audit/events
 * Query params: limit, offset, ticketId, eventType, category, severity, fromDate, toDate
 */
export async function getEvents(
  req: FastifyRequest<{ Querystring: AuditEventFilters & Record<string, string | undefined> }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const q = req.query;
    const filters: AuditEventFilters = {
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
      ticketId: q.ticketId || undefined,
      eventType: q.eventType || undefined,
      category: q.category || undefined,
      severity: q.severity || undefined,
      actorUserId: q.actorUserId || undefined,
      fromDate: q.fromDate || undefined,
      toDate: q.toDate || undefined,
    };
    // FIX A1+A2: pasar tenantId. super_admin con ?allTenants=true ve "*".
    const isSuperAdmin = (req.user?.role as string) === "admin";
    const allTenants = (q as { allTenants?: string }).allTenants === "true";
    const scope = isSuperAdmin && allTenants ? "*" : req.tenantId;
    const events = await listAuditEvents(scope, filters);
    reply.send({ success: true, events, count: events.length });
  } catch (err) {
    logger.error({ err }, "audit-events.getEvents fail");
    reply.code(500).send({ success: false, error: "Error obteniendo eventos" });
  }
}

/**
 * GET /api/audit/events/by-ticket/:ticketKey
 * Devuelve los eventos de un ticket en orden cronológico ASC (timeline).
 */
export async function getByTicket(
  req: FastifyRequest<{ Params: { ticketKey: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    // FIX A2: scope al tenant del request.
    const events = await getAuditByTicket(req.tenantId, req.params.ticketKey);
    reply.send({ success: true, events, count: events.length });
  } catch (err) {
    logger.error({ err }, "audit-events.getByTicket fail");
    reply.code(500).send({ success: false, error: "Error obteniendo eventos del ticket" });
  }
}

/**
 * POST /api/audit/events
 * Body: AuditEventInput. Si el caller está autenticado, completamos actor desde request.user.
 */
export async function postEvent(
  req: FastifyRequest<{ Body: AuditEventInput }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const body = req.body;
    if (!body || !body.eventType) {
      reply.code(400).send({ success: false, error: "eventType es requerido" });
      return;
    }
    // FIX A1: completar tenantId desde request.
    // FIX B10 (bajo): no usar email como actorName si nombre disponible.
    const user = req.user;
    const enriched: AuditEventInput = {
      ...body,
      tenantId: body.tenantId ?? req.tenantId ?? null,
      actorUserId: body.actorUserId ?? user?.id ?? null,
      actorName: body.actorName ?? user?.name ?? null, // sin fallback email
      actorRole: body.actorRole ?? user?.role ?? null,
    };
    const event = await recordAuditEvent(enriched);
    if (!event) {
      reply.code(500).send({ success: false, error: "No se pudo registrar el evento" });
      return;
    }
    reply.code(201).send({ success: true, event });
  } catch (err) {
    logger.error({ err }, "audit-events.postEvent fail");
    reply.code(500).send({ success: false, error: "Error registrando evento" });
  }
}

/** GET /api/audit/summary — KPIs agregados, tenant scoped. */
export async function getSummary(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    // FIX A2: super_admin con ?allTenants=true ve global; resto tenant scoped.
    const isSuperAdmin = (req.user?.role as string) === "admin";
    const allTenants = (req.query as { allTenants?: string } | undefined)?.allTenants === "true";
    const scope = isSuperAdmin && allTenants ? "*" : req.tenantId;
    const summary = await getAuditSummary(scope);
    reply.send({ success: true, summary });
  } catch (err) {
    logger.error({ err }, "audit-events.getSummary fail");
    reply.code(500).send({ success: false, error: "Error obteniendo summary" });
  }
}
