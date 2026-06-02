import type { FastifyInstance } from "fastify";
import {
  postSaveResponse, getListByTicket, patchStatus, deleteOne, getOne,
} from "../controllers/customer-response.controller";
import type { SaveCustomerResponseInput } from "../services/customer-response.service";

export async function customerResponseRoutes(app: FastifyInstance) {
  app.post<{ Params: { key: string }; Body: SaveCustomerResponseInput }>(
    "/api/tickets/:key/responses", postSaveResponse);
  app.get<{ Params: { key: string } }>(
    "/api/tickets/:key/responses", getListByTicket);
  app.get<{ Params: { responseId: string } }>(
    "/api/customer-responses/:responseId", getOne);
  app.patch<{ Params: { responseId: string }; Body: { status: string } }>(
    "/api/customer-responses/:responseId/status", patchStatus);
  app.delete<{ Params: { responseId: string } }>(
    "/api/customer-responses/:responseId", deleteOne);
}
