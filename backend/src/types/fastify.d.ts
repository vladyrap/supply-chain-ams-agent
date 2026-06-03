// =============================================================================
// Declaration merging para Fastify — request.user inyectado por requireAuth.
// =============================================================================

import type { User } from "./auth.types";

declare module "fastify" {
  interface FastifyRequest {
    /** User autenticado, inyectado por el preHandler `requireAuth`. Undefined si la ruta es pública. */
    user?: User;
    /** Session token usado para validar al user. Para auditoría. */
    sessionId?: string;
  }
}
