import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import { getDashboardAdvanced, getDashboardExecutive } from "../services/dashboard.service";
import { listNotifications } from "../services/notifications.service";
import { getUsageSummary } from "../services/usage.service";

export async function getDashboardAdv(req: FastifyRequest, reply: FastifyReply) {
  try {
    const d = await getDashboardAdvanced(req.tenantId);
    return reply.send({ success: true, dashboard: d });
  } catch (err) {
    logger.error({ err }, "dashboard.advanced fail");
    return reply.code(500).send({ success: false, error: "Error calculando dashboard" });
  }
}

export async function getDashboardExec(
  req: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply
) {
  try {
    const days = req.query.days ? parseInt(req.query.days, 10) : 30;
    const d = await getDashboardExecutive(req.tenantId, Number.isFinite(days) ? days : 30);
    return reply.send({ success: true, dashboard: d });
  } catch (err) {
    logger.error({ err }, "dashboard.executive fail");
    return reply.code(500).send({ success: false, error: "Error calculando dashboard ejecutivo" });
  }
}

export async function getUsageRoute(
  req: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply
) {
  try {
    const days = req.query.days ? parseInt(req.query.days, 10) : 30;
    const summary = await getUsageSummary(req.tenantId, Number.isFinite(days) ? days : 30);
    return reply.send({ success: true, usage: summary });
  } catch (err) {
    logger.error({ err }, "usage.summary fail");
    return reply.code(500).send({ success: false, error: "Error calculando usage" });
  }
}

export async function getNotificationsRoute(
  req: FastifyRequest<{ Querystring: { since?: string; limit?: string } }>,
  reply: FastifyReply
) {
  try {
    const since = req.query.since;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 30;
    const list = await listNotifications(req.tenantId, { since, limit });
    return reply.send({ success: true, count: list.length, notifications: list });
  } catch (err) {
    logger.error({ err }, "notifications fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo notificaciones" });
  }
}
