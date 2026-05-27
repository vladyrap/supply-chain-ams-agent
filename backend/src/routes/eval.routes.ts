import type { FastifyInstance } from "fastify";
import { postCreateEval, getEvalsList, getEvalDetail } from "../controllers/eval.controller";

export async function evalRoutes(app: FastifyInstance) {
  app.post("/api/eval/runs", postCreateEval);
  app.get("/api/eval/runs", getEvalsList);
  app.get("/api/eval/runs/:id", getEvalDetail);
}
