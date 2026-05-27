import type { FastifyInstance } from "fastify";
import {
  postInboundIdoc, postInboundShortDump, postInboundOssNote,
  postInboundJobFailure, postInboundTransport, postInboundGeneric,
  getInboundEvents, getInboundEventDetail,
  postCreateToken, getTokens, delToken,
} from "../controllers/sap-inbound.controller";

export async function sapInboundRoutes(app: FastifyInstance) {
  // Endpoints que SAP llama (necesitan header X-AMS-Inbound-Token o Bearer)
  app.post("/api/sap/inbound/idoc",         postInboundIdoc);
  app.post("/api/sap/inbound/short-dump",   postInboundShortDump);
  app.post("/api/sap/inbound/oss-note",     postInboundOssNote);
  app.post("/api/sap/inbound/job-failure",  postInboundJobFailure);
  app.post("/api/sap/inbound/transport",    postInboundTransport);
  app.post("/api/sap/inbound/generic",      postInboundGeneric);

  // Lectura desde la plataforma (sesión normal)
  app.get("/api/sap/inbound/events",        getInboundEvents);
  app.get("/api/sap/inbound/events/:id",    getInboundEventDetail);

  // Tokens management (admin)
  app.get("/api/sap/inbound/tokens",        getTokens);
  app.post("/api/sap/inbound/tokens",       postCreateToken);
  app.delete("/api/sap/inbound/tokens/:id", delToken);
}
