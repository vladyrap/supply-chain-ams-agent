import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  createEvalRun, executeEvalRunFireAndForget, getEvalRun, listEvalRuns,
  type EvalConfig, type EvalQuestion,
} from "../services/eval.service";

interface CreateBody {
  name?: string;
  configs?: EvalConfig[];
  questions?: EvalQuestion[];
}

export async function postCreateEval(
  req: FastifyRequest<{ Body: CreateBody }>,
  reply: FastifyReply
) {
  const { name, configs, questions } = req.body ?? {};
  if (!name?.trim()) return reply.code(400).send({ success: false, error: "name requerido" });
  if (!Array.isArray(configs) || configs.length === 0) {
    return reply.code(400).send({ success: false, error: "configs requerido (array no vacío)" });
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    return reply.code(400).send({ success: false, error: "questions requerido (array no vacío)" });
  }
  for (const c of configs) {
    if (!c.label?.trim() || !c.model?.trim()) {
      return reply.code(400).send({ success: false, error: "cada config requiere label y model" });
    }
  }
  try {
    const { runIds } = await createEvalRun(req.tenantId, name.trim(), configs, questions);
    // Lanza la ejecución en background — no bloquea la respuesta.
    for (const id of runIds) executeEvalRunFireAndForget(req.tenantId, id);
    return reply.send({ success: true, runIds });
  } catch (err) {
    logger.error({ err }, "eval: create fail");
    return reply.code(500).send({ success: false, error: "Error creando eval run" });
  }
}

export async function getEvalsList(req: FastifyRequest, reply: FastifyReply) {
  try {
    const runs = await listEvalRuns(req.tenantId);
    return reply.send({ success: true, count: runs.length, runs });
  } catch (err) {
    logger.error({ err }, "eval: list fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}

export async function getEvalDetail(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const { run, results } = await getEvalRun(req.tenantId, req.params.id);
    if (!run) return reply.code(404).send({ success: false, error: "no encontrado" });
    return reply.send({ success: true, run, results });
  } catch (err) {
    logger.error({ err }, "eval: detail fail");
    return reply.code(500).send({ success: false, error: "Error" });
  }
}
