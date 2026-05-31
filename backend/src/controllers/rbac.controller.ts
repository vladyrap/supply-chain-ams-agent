import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import * as svc from "../services/rbac.service";

export async function getSnapshot(_req: FastifyRequest, reply: FastifyReply) {
  try { return reply.send({ success: true, ...(await svc.getSnapshot()) }); }
  catch (err) { logger.error({ err }, "rbac.snapshot fail"); return reply.code(500).send({ success: false, error: "Error obteniendo snapshot" }); }
}
export async function upsertRole(req: FastifyRequest<{ Body: svc.PlatformRole }>, reply: FastifyReply) {
  try { return reply.send({ success: true, role: await svc.upsertRole(req.body) }); }
  catch (err) { logger.error({ err }, "rbac.upsertRole fail"); return reply.code(500).send({ success: false, error: "Error guardando rol" }); }
}
export async function deleteRole(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await svc.deleteRole(req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "rbac.deleteRole fail"); return reply.code(500).send({ success: false, error: "Error eliminando rol" }); }
}
export async function upsertUser(req: FastifyRequest<{ Body: svc.PlatformUser }>, reply: FastifyReply) {
  try { return reply.send({ success: true, user: await svc.upsertUser(req.body) }); }
  catch (err) { logger.error({ err }, "rbac.upsertUser fail"); return reply.code(500).send({ success: false, error: "Error guardando usuario" }); }
}
export async function deleteUser(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  try { await svc.deleteUser(req.params.id); return reply.send({ success: true }); }
  catch (err) { logger.error({ err }, "rbac.deleteUser fail"); return reply.code(500).send({ success: false, error: "Error eliminando usuario" }); }
}
export async function postResetDemo(_req: FastifyRequest, reply: FastifyReply) {
  try { await svc.resetDemo(); return reply.send({ success: true, ...(await svc.getSnapshot()) }); }
  catch (err) { logger.error({ err }, "rbac.reset fail"); return reply.code(500).send({ success: false, error: "Error reset demo" }); }
}
