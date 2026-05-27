import type { FastifyInstance } from "fastify";
import {
  postCreateDestination,
  getDestinations,
  getDestinationDetail,
  patchDestination,
  delDestination,
  postTestDestination,
  getDeliveries,
  postEmit,
  getKnownEvents,
} from "../controllers/integration.controller";

export async function integrationRoutes(app: FastifyInstance) {
  app.get("/api/integrations/destinations", getDestinations);
  app.post("/api/integrations/destinations", postCreateDestination);
  app.get("/api/integrations/destinations/:id", getDestinationDetail);
  app.patch("/api/integrations/destinations/:id", patchDestination);
  app.delete("/api/integrations/destinations/:id", delDestination);
  app.post("/api/integrations/destinations/:id/test", postTestDestination);

  app.get("/api/integrations/deliveries", getDeliveries);
  app.get("/api/integrations/events", getKnownEvents);
  app.post("/api/integrations/emit", postEmit);
}
