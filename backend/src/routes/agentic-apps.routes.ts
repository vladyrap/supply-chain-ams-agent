// =============================================================================
// agentic-apps.routes.ts — v1.3 Agent Hub · Apps Agénticas
// =============================================================================

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requirePermission } from "../middleware/requirePermission";
import * as svc from "../services/agentic-apps.service";
import { logger } from "../utils/logger";

type Req = FastifyRequest & { tenantId: string };

export async function agenticAppsRoutes(app: FastifyInstance) {
  app.get("/api/apps",
    { preHandler: requirePermission("agente_ams", "view") },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const r = req as Req;
      try {
        const apps = await svc.listApps(r.tenantId);
        return reply.send({ success: true, count: apps.length, apps });
      } catch (err) {
        logger.error({ err }, "apps.list fail");
        return reply.code(500).send({ success: false, error: "Error listando apps" });
      }
    });

  app.get<{ Params: { id: string } }>("/api/apps/:id",
    { preHandler: requirePermission("agente_ams", "view") },
    async (req, reply) => {
      const r = req as unknown as Req;
      try {
        const found = await svc.getApp(r.tenantId, req.params.id);
        if (!found) return reply.code(404).send({ success: false, error: "App no encontrada" });
        return reply.send({ success: true, app: found });
      } catch (err) {
        logger.error({ err }, "apps.get fail");
        return reply.code(500).send({ success: false, error: "Error obteniendo app" });
      }
    });

  app.post("/api/apps",
    { preHandler: requirePermission("agente_ams", "create") },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const r = req as Req;
      try {
        const created = await svc.createApp(r.tenantId, (req.body || {}) as svc.CreateAppInput);
        return reply.code(201).send({ success: true, app: created });
      } catch (err) {
        logger.error({ err }, "apps.create fail");
        return reply.code(400).send({ success: false, error: (err as Error).message });
      }
    });

  app.delete<{ Params: { id: string } }>("/api/apps/:id",
    { preHandler: requirePermission("agente_ams", "delete") },
    async (req, reply) => {
      const r = req as unknown as Req;
      try {
        const ok = await svc.deleteApp(r.tenantId, req.params.id);
        if (!ok) return reply.code(404).send({ success: false, error: "App no encontrada" });
        return reply.send({ success: true });
      } catch (err) {
        logger.error({ err }, "apps.delete fail");
        return reply.code(500).send({ success: false, error: "Error eliminando app" });
      }
    });

  // Ejecutar (crea run en background, devuelve runId para polling)
  app.post<{ Params: { id: string } }>("/api/apps/:id/run",
    { preHandler: requirePermission("agente_ams", "view") },
    async (req, reply) => {
      const r = req as unknown as Req;
      const b = (req.body || {}) as { input?: string; user?: string };
      if (!b.input?.trim()) {
        return reply.code(400).send({ success: false, error: "input es obligatorio" });
      }
      try {
        const run = await svc.startRun(r.tenantId, req.params.id, b.input, b.user ?? null);
        return reply.code(202).send({ success: true, run });
      } catch (err) {
        logger.error({ err }, "apps.run fail");
        return reply.code(400).send({ success: false, error: (err as Error).message });
      }
    });

  // Polling del run
  app.get<{ Params: { runId: string } }>("/api/apps/runs/:runId",
    { preHandler: requirePermission("agente_ams", "view") },
    async (req, reply) => {
      const r = req as unknown as Req;
      try {
        const run = await svc.getRun(r.tenantId, req.params.runId);
        if (!run) return reply.code(404).send({ success: false, error: "Run no encontrado" });
        return reply.send({ success: true, run });
      } catch (err) {
        logger.error({ err }, "apps.run.get fail");
        return reply.code(500).send({ success: false, error: "Error obteniendo run" });
      }
    });

  // Historial de runs de una app
  app.get<{ Params: { id: string } }>("/api/apps/:id/runs",
    { preHandler: requirePermission("agente_ams", "view") },
    async (req, reply) => {
      const r = req as unknown as Req;
      try {
        const runs = await svc.listRuns(r.tenantId, req.params.id);
        return reply.send({ success: true, runs });
      } catch (err) {
        logger.error({ err }, "apps.runs.list fail");
        return reply.code(500).send({ success: false, error: "Error listando runs" });
      }
    });
}
