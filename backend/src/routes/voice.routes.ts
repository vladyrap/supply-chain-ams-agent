// Canal Telefonico IA — rutas Fastify.
// Twilio webhooks usan application/x-www-form-urlencoded. El parser correspondiente
// se registra a nivel de app en server.ts (@fastify/formbody).
//
// IMPORTANTE: estos endpoints NO requieren cookie de sesion porque los llama Twilio.
// La autenticidad se valida (opcionalmente) con X-Twilio-Signature dentro del
// controller / middleware futuro. Ver docs/voice y README.

import type { FastifyInstance } from "fastify";
import {
  postIncomingCall,
  postProcessSpeech,
  postCallStatus,
  getCallsList,
  getCallDetail,
} from "../controllers/voice.controller";

export async function voiceRoutes(app: FastifyInstance) {
  // Webhooks de Twilio (form-urlencoded)
  app.post("/api/voice/incoming",         postIncomingCall);
  app.post("/api/voice/process-speech",   postProcessSpeech);
  app.post("/api/voice/status",           postCallStatus);

  // Lectura para frontend / admin
  app.get("/api/voice/calls",             getCallsList);
  app.get<{ Params: { callSid: string } }>("/api/voice/calls/:callSid", getCallDetail);
}
