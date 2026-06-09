import type { FastifyInstance } from "fastify";
import {
  postStartConversation,
  postSendMessage,
  getConversations,
  getConversationDetail,
  postCloseConversation,
  postManualEscalate,
  getTicketsRoute,
  getTicketDetail,
  postAssignTicket,
  postResolveTicket,
  postCloseTicket,
  patchTicketStatus,
  getKbArticles,
  getKbArticleDetail,
  postCreateKb,
  postApproveKb,
  postArchiveKb,
  deleteKb,
  postKbHelpful,
  getMetrics,
} from "../controllers/support.controller";
import { requireAuth } from "../middleware/requireAuth";
import { requirePermission } from "../middleware/requirePermission";

// FIX C7 (audit v1.1.0): RBAC en rutas mutantes.
// Mapeo a PlatformScreen real del RBAC:
//   - support → "incidentes" (tickets/conversations)
//   - knowledge → "conocimiento_rag"
const READ = { preHandler: requireAuth };
const TICKETS_WRITE = { preHandler: requirePermission("incidentes", "edit") };
const KB_WRITE = { preHandler: requirePermission("conocimiento_rag", "edit") };
const KB_APPROVE = { preHandler: requirePermission("conocimiento_rag", "approve") };
const KB_DELETE = { preHandler: requirePermission("conocimiento_rag", "delete") };

export async function supportRoutes(app: FastifyInstance) {
  app.post("/api/support/conversations", READ, postStartConversation as never);
  app.get("/api/support/conversations", READ, getConversations as never);
  app.get("/api/support/conversations/:id", READ, getConversationDetail as never);
  app.post("/api/support/conversations/:id/messages", READ, postSendMessage as never);
  app.post("/api/support/conversations/:id/close", TICKETS_WRITE, postCloseConversation as never);
  app.post("/api/support/conversations/:id/escalate", TICKETS_WRITE, postManualEscalate as never);

  app.get("/api/support/tickets", READ, getTicketsRoute as never);
  app.get("/api/support/tickets/:id", READ, getTicketDetail as never);
  app.post("/api/support/tickets/:id/assign", TICKETS_WRITE, postAssignTicket as never);
  app.post("/api/support/tickets/:id/resolve", TICKETS_WRITE, postResolveTicket as never);
  app.post("/api/support/tickets/:id/close", TICKETS_WRITE, postCloseTicket as never);
  app.patch("/api/support/tickets/:id/status", TICKETS_WRITE, patchTicketStatus as never);

  app.get("/api/support/kb", READ, getKbArticles as never);
  app.get("/api/support/kb/:id", READ, getKbArticleDetail as never);
  app.post("/api/support/kb", KB_WRITE, postCreateKb as never);
  app.post("/api/support/kb/:id/approve", KB_APPROVE, postApproveKb as never);
  app.post("/api/support/kb/:id/archive", KB_APPROVE, postArchiveKb as never);
  app.delete("/api/support/kb/:id", KB_DELETE, deleteKb as never);
  app.post("/api/support/kb/:id/helpful", READ, postKbHelpful as never);

  app.get("/api/support/metrics", READ, getMetrics);
}
