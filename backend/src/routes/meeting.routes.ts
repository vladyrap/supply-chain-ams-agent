import type { FastifyInstance } from "fastify";
import {
  postUpload,
  getMeetings,
  getMeeting,
  delMeeting,
} from "../controllers/meeting.controller";

export async function meetingRoutes(app: FastifyInstance) {
  app.post("/api/meetings/upload", postUpload);
  app.get("/api/meetings", getMeetings);
  app.get<{ Params: { id: string } }>("/api/meetings/:id", getMeeting);
  app.delete<{ Params: { id: string } }>("/api/meetings/:id", delMeeting);
}
