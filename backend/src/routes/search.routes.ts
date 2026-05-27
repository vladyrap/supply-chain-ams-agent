import type { FastifyInstance } from "fastify";
import {
  getSearch, postReindex, getSearchStatsRoute,
} from "../controllers/search.controller";

export async function searchRoutes(app: FastifyInstance) {
  app.get("/api/search", getSearch);
  app.get("/api/search/stats", getSearchStatsRoute);
  app.post("/api/search/reindex", postReindex);
}
