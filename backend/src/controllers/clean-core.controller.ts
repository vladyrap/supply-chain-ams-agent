// =============================================================================
// clean-core.controller.ts — Refactor Z → Clean Core (HANA) con IA (ROCCO)
// =============================================================================
// Reutiliza chatWithAgent() con un system prompt inmutable de ROCCO especializado
// en llevar ABAP clásico a Clean Core optimizado para HANA / ABAP Cloud. El modelo
// (Gemini o Claude) se elige por request y se valida contra ALLOWED_AGENT_MODELS.
//
// La identidad es la de la sesión (req.user, inyectado por requireAuth vía
// requirePermission). El código enviado nunca reemplaza el prompt de sistema.
// =============================================================================

import type { FastifyRequest, FastifyReply } from "fastify";
import { chatWithAgent } from "../services/claude.service";
import { ALLOWED_AGENT_MODELS } from "../services/custom-agents.service";
import { logger } from "../utils/logger";

interface Req extends FastifyRequest {
  tenantId: string;
}

const MAX_CODE = 12000;

const ROCCO_ABAP_SYSTEM_PROMPT = `Eres ROCCO, consultor SAP senior especializado en Clean Core, S/4HANA y ABAP para Cloud.
Tu tarea: recibir un objeto ABAP clásico (Z/Y heredado de ECC) y devolver una versión refactorizada a Clean Core, optimizada para HANA y compatible con ABAP Cloud, sin cambiar la intención funcional.

Reglas de refactor (obligatorias):
- Nunca escribas directo (INSERT/UPDATE/MODIFY/DELETE) sobre tablas SAP estándar: usá la BAPI/API released o el objeto de negocio (RAP).
- Reemplazá lecturas directas de tablas estándar por CDS views released (I_*). Seleccioná sólo los campos usados (nunca SELECT *).
- Sacá los SELECT de dentro de LOOP: resolvé con JOIN / CDS / FOR ALL ENTRIES (con resguardo de tabla vacía) o code pushdown (CDS/AMDP).
- Eliminá sintaxis obsoleta no permitida en ABAP Cloud: TABLES, HEADER LINE/OCCURS, WRITE/listas clásicas, CALL TRANSACTION/SCREEN, SUBMIT, EXEC SQL nativo.
- Reemplazá modificaciones/enhancements sobre estándar por BAdI released o extensibility (in-app / side-by-side BTP).
- No inventes nombres de tablas, campos, CDS o APIs que no puedas inferir con seguridad; si falta contexto, indicá el supuesto explícitamente.

Formato de salida (Markdown, en español):
## Diagnóstico
Lista breve de los anti-patrones detectados.
## Código refactorizado
Un único bloque \`\`\`abap con la versión limpia (ABAP Cloud-ready cuando sea posible).
## Notas de migración
Qué cambió y por qué (mapear cada cambio a la regla Clean Core / HANA).
## Requiere decisión
Supuestos hechos y lo que necesita validación funcional o un workshop.

Sé preciso y conciso. No agregues texto fuera de esa estructura.`;

export async function postCleanCoreRefactor(req: FastifyRequest, reply: FastifyReply) {
  const r = req as unknown as Req;
  const b = (req.body || {}) as { code?: string; model?: string };
  const code = (b.code ?? "").trim();
  if (!code) {
    return reply.code(400).send({ success: false, error: "code es obligatorio" });
  }
  if (code.length > MAX_CODE) {
    return reply.code(400).send({ success: false, error: `code supera ${MAX_CODE} caracteres` });
  }
  const model = (b.model ?? "").trim();
  if (model && !(ALLOWED_AGENT_MODELS as readonly string[]).includes(model)) {
    return reply.code(400).send({
      success: false,
      error: `Modelo "${model}" no permitido. Opciones: ${ALLOWED_AGENT_MODELS.join(", ")}`,
    });
  }

  try {
    const result = await chatWithAgent({
      userMessage:
        "Refactorizá el siguiente objeto ABAP a Clean Core optimizado para HANA / ABAP Cloud, " +
        "siguiendo estrictamente tu formato de salida.\n\n```abap\n" + code + "\n```",
      user: req.user?.email ?? "anonymous",
      module: "ABAP",
      client: "clean-core",
      environment: "DEV",
      tenantId: r.tenantId,
      systemPromptOverride: ROCCO_ABAP_SYSTEM_PROMPT,
      modelOverride: model || undefined,
    });
    return reply.send({ success: true, refactored: result.text, model: result.model });
  } catch (err) {
    const msg = (err as Error).message || "error";
    logger.error({ err }, "clean-core.refactor fail");
    const status = /no permitido/.test(msg) ? 400
      : /API key|api_key|ANTHROPIC|GEMINI|not configured|no configurad/i.test(msg) ? 503
      : /límite|rate|quota/i.test(msg) ? 429 : 500;
    return reply.code(status).send({ success: false, error: msg });
  }
}
