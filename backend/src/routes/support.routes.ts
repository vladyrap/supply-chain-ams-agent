import type { FastifyInstance } from "fastify";
import {
  postStartConversation,
  postSendMessage,
  getConversations,
  getConversationDetail,
  postCloseConversation,
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

// Dejamos que Fastify infiera los tipos de los handlers (evita TS2769 cuando
// hay Params + Body simultáneos en el genérico de la ruta).
export async function supportRoutes(app: FastifyInstance) {
  // Conversations
  app.post("/api/support/conversations", postStartConversation);
  app.get("/api/support/conversations", getConversations);
  app.get("/api/support/conversations/:id", getConversationDetail);
  app.post("/api/support/conversations/:id/messages", postSendMessage);
  app.post("/api/support/conversations/:id/close", postCloseConversation);

  // Tickets
  app.get("/api/support/tickets", getTicketsRoute);
  app.get("/api/support/tickets/:id", getTicketDetail);
  app.post("/api/support/tickets/:id/assign", postAssignTicket);
  app.post("/api/support/tickets/:id/resolve", postResolveTicket);
  app.post("/api/support/tickets/:id/close", postCloseTicket);
  app.patch("/api/support/tickets/:id/status", patchTicketStatus);

  // KB
  app.get("/api/support/kb", getKbArticles);
  app.get("/api/support/kb/:id", getKbArticleDetail);
  app.post("/api/support/kb", postCreateKb);
  app.post("/api/support/kb/:id/approve", postApproveKb);
  app.post("/api/support/kb/:id/archive", postArchiveKb);
  app.delete("/api/support/kb/:id", deleteKb);
  app.post("/api/support/kb/:id/helpful", postKbHelpful);

  // Métricas
  app.get("/api/support/metrics", getMetrics);
}
