// =============================================================================
// Task Router backend — espejo del frontend src/intelligence/providers/llm-provider-adapter.ts
// =============================================================================
// Centraliza la decisión de qué modelo Gemini y qué prompt pack usar por tarea.
// La matriz preferida es la misma que el frontend declara; este módulo agrega
// la dimensión "modelo Gemini concreto" porque solo este side llama la API.
//
// IMPORTANTE: si no hay override explícito en el caller, devuelve siempre la
// configuración "compatibilidad" (gemini-2.5-flash + system-base.md) para
// preservar paridad con el comportamiento previo a v0.13.
// =============================================================================

export type LLMTaskType =
  | "CHAT"                 // chat libre con el Agente AMS (legacy /ams/chat)
  | "CLASSIFICATION"       // POST /api/tickets/:key/classify
  | "ESTIMATION"           // futuro: estimaciones via LLM
  | "RCA"                  // RCA generation (future)
  | "CUSTOMER_RESPONSE"    // (no usado hoy, motor determinístico)
  | "QUALITY_GATE"         // (no usado hoy, motor determinístico)
  | "DOCUMENTATION"        // generación de docs (RCA, post-mortem)
  | "SUMMARY"              // resúmenes
  | "TECHNICAL_REASONING"; // razonamiento técnico (future)

export interface TaskRouteConfig {
  /** Modelo Gemini a usar. */
  model: string;
  /** Temperature. */
  temperature: number;
  /** Max output tokens. */
  maxOutputTokens: number;
  /** Pide structured output JSON. */
  jsonOutput: boolean;
  /** Nombre del prompt pack a cargar (sin extensión). */
  promptPack: string;
}

/** Modelo por defecto — mismo que existía antes de v0.13. */
const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Matriz declarativa task → config.
 * Estos defaults conservan el comportamiento histórico para tareas que ya
 * funcionaban (CHAT, CLASSIFICATION). Las tareas nuevas piden JSON estructurado.
 */
const TASK_CONFIG: Record<LLMTaskType, TaskRouteConfig> = {
  CHAT: {
    model: DEFAULT_MODEL,
    temperature: 0.4,
    maxOutputTokens: 4096,
    jsonOutput: false,
    promptPack: "system-base",
  },
  CLASSIFICATION: {
    model: DEFAULT_MODEL,
    temperature: 0.3,
    maxOutputTokens: 2048,
    jsonOutput: true,
    promptPack: "classify",
  },
  ESTIMATION: {
    model: DEFAULT_MODEL,
    temperature: 0.2,
    maxOutputTokens: 1024,
    jsonOutput: true,
    promptPack: "summary",
  },
  RCA: {
    model: DEFAULT_MODEL,
    temperature: 0.4,
    maxOutputTokens: 4096,
    jsonOutput: false,
    promptPack: "rca",
  },
  CUSTOMER_RESPONSE: {
    model: DEFAULT_MODEL,
    temperature: 0.3,
    maxOutputTokens: 2048,
    jsonOutput: true,
    promptPack: "customer_response",
  },
  QUALITY_GATE: {
    model: DEFAULT_MODEL,
    temperature: 0.1,
    maxOutputTokens: 1024,
    jsonOutput: true,
    promptPack: "customer_response", // reusa el pack
  },
  DOCUMENTATION: {
    model: DEFAULT_MODEL,
    temperature: 0.4,
    maxOutputTokens: 8192,
    jsonOutput: false,
    promptPack: "rca",
  },
  SUMMARY: {
    model: DEFAULT_MODEL,
    temperature: 0.3,
    maxOutputTokens: 1024,
    jsonOutput: true,
    promptPack: "summary",
  },
  TECHNICAL_REASONING: {
    model: DEFAULT_MODEL,
    temperature: 0.4,
    maxOutputTokens: 4096,
    jsonOutput: false,
    promptPack: "system-base",
  },
};

export interface TaskRouteContext {
  /** Si true, fuerza modo MOCK (no llama a Gemini). */
  forceMock?: boolean;
  /** Override de modelo (debugging). */
  modelOverride?: string;
}

/** Si forceMock está activo o env NEXT_PUBLIC_FORCE_MOCK_LLM=1. */
export function isMockMode(ctx: TaskRouteContext = {}): boolean {
  if (ctx.forceMock) return true;
  return process.env.FORCE_MOCK_LLM === "1";
}

/**
 * Devuelve la config para la tarea pedida.
 * Si no se especifica taskType (legacy callers), usa CHAT — comportamiento histórico.
 */
export function selectModelForTask(
  taskType: LLMTaskType = "CHAT",
  ctx: TaskRouteContext = {},
): TaskRouteConfig {
  const base = TASK_CONFIG[taskType] ?? TASK_CONFIG.CHAT;
  if (ctx.modelOverride) {
    return { ...base, model: ctx.modelOverride };
  }
  return base;
}

/** Para audit / docs. */
export function listKnownTasks(): LLMTaskType[] {
  return Object.keys(TASK_CONFIG) as LLMTaskType[];
}
