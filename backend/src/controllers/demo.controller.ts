import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import { runDemoScenario } from "../services/demo.service";

// Stream SSE de pasos del escenario.
export async function streamDemoRun(req: FastifyRequest, reply: FastifyReply) {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  // CORS manual (reply.hijack desactiva el handler global)
  const origin = req.headers.origin;
  if (origin) reply.raw.setHeader("Access-Control-Allow-Origin", origin);
  reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
  reply.hijack();

  const write = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    write("start", { ts: Date.now() });
    for await (const step of runDemoScenario(req.tenantId)) {
      write("step", step);
      if (step.kind === "done" || step.kind === "error") break;
    }
    write("end", { ts: Date.now() });
  } catch (err) {
    logger.error({ err }, "demo stream fail");
    write("error", { message: (err as Error)?.message ?? "error" });
  } finally {
    reply.raw.end();
  }
}
