// Port liviano del engine de autoestimación del frontend
// (supply-chain-ams-platform/src/lib/estimation/engine.ts).
//
// Convención: si cambiás reglas acá, sincronizalas en el frontend (~80 líneas).
// Mantenido determinístico y sin dependencias externas.

export type ComplexityLevel = "VERY_LOW" | "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH" | "UNKNOWN";
export type SeverityLevel   = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type UrgencyLevel    = "NORMAL" | "URGENT" | "IMMEDIATE";
export type EnvironmentLevel = "DEV" | "QA" | "UAT" | "PRD" | "SANDBOX" | "TRAINING" | "NO_INFORMADO";
export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";
export type RequiredProfile =
  | "FUNCTIONAL_CONSULTANT" | "ABAP_DEVELOPER" | "INTEGRATION_CONSULTANT"
  | "BTP_CONSULTANT" | "BASIS_CONSULTANT" | "TESTING_CONSULTANT"
  | "AMS_LEAD" | "SAP_ARCHITECT" | "KEY_USER" | "BUSINESS_USER" | "PROJECT_MANAGER";

export type TicketEstimateOrigin =
  | "agent_chat" | "manual_incident" | "escalation_n2"
  | "testing_defect" | "jira_demo" | "servicenow_demo"
  | "support_desk" | "demo_cliente" | "other";

export type TicketKind = "incident" | "change_request" | "service_request";

export interface TicketEstimatePhase {
  id: string;
  name: string;
  description: string;
  minHours: number;
  maxHours: number;
  ownerProfile: RequiredProfile;
  required: boolean;
  status?: "pending" | "in_progress" | "done" | "skipped";
  dependencies: string[];
  deliverables: string[];
}

export interface TicketEstimateInput {
  ticketId: string;
  origin: TicketEstimateOrigin;
  kind?: TicketKind;
  title: string;
  description?: string;
  sapModule?: string;
  process?: string;
  environment?: EnvironmentLevel;
  severity?: SeverityLevel;
  priority?: UrgencyLevel;
  complexity?: ComplexityLevel;
  agentConfidence?: string | null;
  requiresDevelopment?: boolean;
  requiresIntegration?: boolean;
  requiresTransport?: boolean;
  requiresUAT?: boolean;
  hasKnownPlaybook?: boolean;
  hasKnowledgeMatch?: boolean;
  isRepeatedIncident?: boolean;
  hasErrorEvidence?: boolean;
  isProductive?: boolean;
  missingData?: string[];
}

export interface TicketEstimatedResolution {
  id: string;
  ticketId: string;
  totalMinHours: number;
  totalMaxHours: number;
  totalMinBusinessDays: number;
  totalMaxBusinessDays: number;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  complexity: ComplexityLevel;
  phaseBreakdown: TicketEstimatePhase[];
  assumptions: string[];
  risks: string[];
  dependencies: string[];
  missingData: string[];
  suggestedSlaMinutes: number;
  generatedAt: string;
  lastRecalculatedAt: string;
  generatedBy: string;
  manuallyAdjusted: boolean;
  adjustedBy?: string;
  adjustmentReason?: string;
  appliedRules: string[];
}

const COMPLEXITY_MULT: Record<ComplexityLevel, number> = {
  VERY_LOW: 0.6, LOW: 0.8, MEDIUM: 1.0, HIGH: 1.4, VERY_HIGH: 1.9, UNKNOWN: 1.2,
};
const SEVERITY_MULT: Record<SeverityLevel, number> = {
  LOW: 0.95, MEDIUM: 1.0, HIGH: 1.10, CRITICAL: 1.25,
};
const URGENCY_MULT: Record<UrgencyLevel, number> = {
  NORMAL: 1.0, URGENT: 1.15, IMMEDIATE: 1.30,
};
const ENV_MULT: Record<EnvironmentLevel, number> = {
  DEV: 0.9, QA: 1.0, UAT: 1.05, PRD: 1.20, SANDBOX: 0.85, TRAINING: 0.85, NO_INFORMADO: 1.0,
};

function p(
  id: string, name: string, description: string,
  minH: number, maxH: number, owner: RequiredProfile,
  opts: { required?: boolean; dependencies?: string[]; deliverables?: string[] } = {},
): TicketEstimatePhase {
  return {
    id, name, description, minHours: minH, maxHours: maxH, ownerProfile: owner,
    required: opts.required ?? true,
    dependencies: opts.dependencies ?? [],
    deliverables: opts.deliverables ?? [],
    status: "pending",
  };
}

function amsStandardPhases(): TicketEstimatePhase[] {
  return [
    p("p01", "Recepción y clasificación", "Triage, validación de impacto y módulo afectado.", 0.25, 0.75, "AMS_LEAD"),
    p("p02", "Análisis funcional inicial", "Diagnóstico funcional + revisión configuración.", 0.5, 2, "FUNCTIONAL_CONSULTANT", { dependencies: ["p01"] }),
    p("p03", "Análisis técnico", "Logs, dumps, debug.", 0.5, 3, "ABAP_DEVELOPER", { required: false, dependencies: ["p02"] }),
    p("p04", "Reproducción del error", "Replicar en QA/SBX.", 0.5, 2, "FUNCTIONAL_CONSULTANT", { dependencies: ["p02"] }),
    p("p05", "Identificación de causa probable", "RCA preliminar.", 0.5, 2, "FUNCTIONAL_CONSULTANT", { dependencies: ["p04"] }),
    p("p06", "Resolución o workaround", "Aplicar fix.", 0.5, 4, "FUNCTIONAL_CONSULTANT", { dependencies: ["p05"], deliverables: ["Solución aplicada"] }),
    p("p07", "Validación en ambiente", "Pruebas con key user.", 0.25, 1.5, "TESTING_CONSULTANT", { dependencies: ["p06"], deliverables: ["Evidencia"] }),
    p("p08", "Comunicación al cliente", "Update + cierre.", 0.25, 0.75, "AMS_LEAD", { dependencies: ["p07"] }),
    p("p09", "Documentación del caso", "Actualizar KB.", 0.25, 1, "FUNCTIONAL_CONSULTANT", { dependencies: ["p08"], deliverables: ["KB actualizada"] }),
    p("p10", "Cierre o escalamiento", "Cerrar o derivar.", 0.1, 0.5, "AMS_LEAD", { dependencies: ["p09"] }),
  ];
}

function criticalPrdExtraPhases(): TicketEstimatePhase[] {
  return [
    p("p11", "Contención inicial", "Workaround urgente.", 0.5, 2, "AMS_LEAD"),
    p("p12", "Escalamiento Nivel 2", "Derivación a N2.", 0.25, 1, "AMS_LEAD", { dependencies: ["p11"] }),
    p("p13", "RCA preliminar", "Causa raíz <24h.", 1, 4, "FUNCTIONAL_CONSULTANT", { dependencies: ["p12"], deliverables: ["RCA preliminar"] }),
    p("p14", "RCA final", "RCA definitivo.", 2, 8, "AMS_LEAD", { dependencies: ["p13"], deliverables: ["RCA final"] }),
    p("p15", "Hypercare", "Monitoreo 48-72h.", 4, 24, "AMS_LEAD", { dependencies: ["p14"] }),
  ];
}

function changeRequestPhases(): TicketEstimatePhase[] {
  return [
    p("c01", "Análisis", "Toma de requerimiento.", 2, 6, "FUNCTIONAL_CONSULTANT"),
    p("c02", "Diseño funcional", "Spec funcional.", 4, 16, "FUNCTIONAL_CONSULTANT", { dependencies: ["c01"], deliverables: ["Spec funcional"] }),
    p("c03", "Diseño técnico", "Spec técnica.", 4, 16, "ABAP_DEVELOPER", { required: false, dependencies: ["c02"], deliverables: ["Spec técnica"] }),
    p("c04", "Configuración", "Customizing.", 2, 12, "FUNCTIONAL_CONSULTANT", { dependencies: ["c02"] }),
    p("c05", "Desarrollo", "Codificación.", 8, 48, "ABAP_DEVELOPER", { required: false, dependencies: ["c03"] }),
    p("c06", "Integración", "Mapeo + iflow.", 8, 40, "INTEGRATION_CONSULTANT", { required: false, dependencies: ["c05"] }),
    p("c07", "Pruebas unitarias", "PU developer.", 2, 8, "ABAP_DEVELOPER", { dependencies: ["c05"] }),
    p("c08", "Pruebas funcionales", "QA funcional.", 4, 16, "TESTING_CONSULTANT", { dependencies: ["c07"] }),
    p("c09", "UAT", "Aceptación key user.", 4, 24, "KEY_USER", { dependencies: ["c08"], deliverables: ["UAT firmada"] }),
    p("c10", "Documentación", "Manual + spec.", 2, 8, "FUNCTIONAL_CONSULTANT", { dependencies: ["c09"] }),
    p("c11", "Transporte", "TR controlado.", 1, 4, "BASIS_CONSULTANT", { dependencies: ["c10"] }),
    p("c12", "Puesta en marcha", "Pase productivo.", 2, 8, "AMS_LEAD", { dependencies: ["c11"], deliverables: ["Productivo"] }),
    p("c13", "Hypercare", "Monitoreo post go-live.", 8, 40, "AMS_LEAD", { dependencies: ["c12"] }),
  ];
}

function normalizeAgentConfidence(v: string | null | undefined): ConfidenceLevel | null {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s === "high" || s === "alta") return "HIGH";
  if (s === "low" || s === "baja") return "LOW";
  if (s === "medium" || s === "media") return "MEDIUM";
  return null;
}

function inferComplexity(input: TicketEstimateInput): ComplexityLevel {
  if (input.complexity && input.complexity !== "UNKNOWN") return input.complexity;
  let score = 2;
  if (input.requiresDevelopment) score += 2;
  if (input.requiresIntegration) score += 2;
  if (input.severity === "CRITICAL") score += 1;
  if (input.isProductive) score += 1;
  if (input.hasKnownPlaybook || input.hasKnowledgeMatch) score -= 1;
  if (input.isRepeatedIncident) score -= 1;
  if (score <= 0) return "VERY_LOW";
  if (score === 1) return "LOW";
  if (score === 2) return "MEDIUM";
  if (score === 3) return "HIGH";
  return "VERY_HIGH";
}

function suggestedSla(severity: SeverityLevel, env: EnvironmentLevel): number {
  if (severity === "CRITICAL" && env === "PRD") return 60;
  if (severity === "CRITICAL") return 240;
  if (severity === "HIGH" && env === "PRD") return 240;
  if (severity === "HIGH") return 480;
  if (severity === "MEDIUM") return 1440;
  return 2880;
}

const uid = (pfx: string) => `${pfx}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
const nowIso = () => new Date().toISOString();

export function autoEstimateTicketResolution(input: TicketEstimateInput): TicketEstimatedResolution {
  const kind = input.kind ?? "incident";
  const severity = input.severity ?? "MEDIUM";
  const env = input.environment ?? "NO_INFORMADO";
  const urgency = input.priority ?? (severity === "CRITICAL" ? "IMMEDIATE" : "NORMAL");
  const complexity = inferComplexity(input);
  const isProductive = !!input.isProductive || env === "PRD";
  const isCriticalPrd = isProductive && severity === "CRITICAL";

  let phases: TicketEstimatePhase[] = kind === "change_request" ? changeRequestPhases() : amsStandardPhases();
  if (kind === "incident" && isCriticalPrd) phases = [...phases, ...criticalPrdExtraPhases()];

  phases = phases.filter((ph) => {
    if (ph.required) return true;
    if (ph.id === "p03" || ph.id === "c03" || ph.id === "c05") return !!input.requiresDevelopment;
    if (ph.id === "c06") return !!input.requiresIntegration;
    return true;
  });

  let baseMin = phases.reduce((s, ph) => s + ph.minHours, 0);
  let baseMax = phases.reduce((s, ph) => s + ph.maxHours, 0);

  const appliedRules: string[] = [];
  const mult = COMPLEXITY_MULT[complexity] * SEVERITY_MULT[severity] * URGENCY_MULT[urgency] * ENV_MULT[env];
  baseMin *= mult; baseMax *= mult;
  appliedRules.push(`mult_base=${mult.toFixed(2)} (complex=${complexity} sev=${severity} urg=${urgency} env=${env})`);

  const bump = (label: string, min: number, max: number) => {
    baseMin += min; baseMax += max; appliedRules.push(`bump:${label} +${min}/+${max}h`);
  };
  if (input.requiresDevelopment) bump("desarrollo", 16, 80);
  if (input.requiresIntegration) bump("integracion", 8, 40);
  if (input.requiresTransport)   bump("transporte", 2, 8);
  if (input.requiresUAT)         bump("UAT", 4, 24);

  const pct = (label: string, factor: number) => {
    baseMin *= factor; baseMax *= factor; appliedRules.push(`pct:${label} x${factor.toFixed(2)}`);
  };
  if (input.hasKnownPlaybook)   pct("playbook_-15%", 0.85);
  if (input.isRepeatedIncident) pct("recurrente_-25%", 0.75);

  const agentConf = normalizeAgentConfidence(input.agentConfidence);
  if (agentConf === "LOW")              pct("agente_baja_+30%", 1.30);
  if (input.hasErrorEvidence === false) pct("sin_evidencia_+20%", 1.20);

  if (baseMin < 0.5) baseMin = 0.5;
  if (baseMax < baseMin) baseMax = baseMin * 1.5;
  const totalMinHours = Math.round(baseMin * 10) / 10;
  const totalMaxHours = Math.round(baseMax * 10) / 10;

  const scale = (totalMinHours + totalMaxHours) / Math.max(0.1,
    phases.reduce((s, ph) => s + ph.minHours + ph.maxHours, 0));
  phases = phases.map((ph) => ({
    ...ph,
    minHours: Math.round(ph.minHours * scale * 10) / 10,
    maxHours: Math.round(ph.maxHours * scale * 10) / 10,
  }));

  const missingData: string[] = [...(input.missingData ?? [])];
  if (!input.sapModule)                 missingData.push("Módulo SAP afectado.");
  if (!input.process)                   missingData.push("Proceso de negocio.");
  if (!input.environment || input.environment === "NO_INFORMADO") missingData.push("Ambiente objetivo.");
  if (input.hasErrorEvidence === false) missingData.push("Mensaje de error o evidencia.");
  if (input.complexity === "UNKNOWN")   missingData.push("Estimación de complejidad.");

  let score = 100;
  if (missingData.length) score -= missingData.length * 10;
  if (complexity === "VERY_HIGH" || complexity === "HIGH") score -= 8;
  if (urgency === "IMMEDIATE") score -= 5;
  if (input.requiresDevelopment) score -= 8;
  if (input.requiresIntegration) score -= 12;
  if (input.hasKnownPlaybook)   score += 8;
  if (input.hasKnowledgeMatch)  score += 6;
  if (input.isRepeatedIncident) score += 8;
  if (agentConf === "LOW") score -= 12;
  if (agentConf === "HIGH") score += 6;
  if (score < 0) score = 0; if (score > 100) score = 100;
  let confidence: ConfidenceLevel = "MEDIUM";
  if (score >= 75) confidence = "HIGH";
  else if (score <= 45) confidence = "LOW";

  if (kind === "change_request") appliedRules.push("rule:change_request_phases");
  if (isCriticalPrd) appliedRules.push("rule:critical_prd_extra_phases");

  const assumptions: string[] = [
    `Estimación basada en módulo ${input.sapModule || "SAP genérico"} y complejidad ${complexity}.`,
    "Horario hábil 9×5 sin recargos.",
    "Equipo cliente disponible para validar en ventana acordada.",
  ];
  if (input.hasKnownPlaybook) assumptions.push("Playbook AMS aplicable, reuso completo.");

  const risks: string[] = [];
  if (complexity === "VERY_HIGH" || complexity === "HIGH") risks.push("Complejidad alta: banda amplia.");
  if (isCriticalPrd) risks.push("Productivo + crítico: impacto al negocio.");
  if (input.requiresDevelopment) risks.push("Desarrollo: variabilidad por scope.");
  if (input.requiresIntegration) risks.push("Integración: depende del externo.");
  if (agentConf === "LOW") risks.push("Confianza del agente baja.");

  const dependencies: string[] = [];
  if (input.requiresUAT)       dependencies.push("Key user disponible para UAT.");
  if (input.requiresTransport) dependencies.push("Ventana de transporte por Basis.");
  if (env === "PRD")           dependencies.push("Plan de back-out validado.");

  const totalMinBusinessDays = +(totalMinHours / 8).toFixed(1);
  const totalMaxBusinessDays = +(totalMaxHours / 8).toFixed(1);
  const slaMin = suggestedSla(severity, env);

  const t = nowIso();
  return {
    id: uid("est"),
    ticketId: input.ticketId,
    totalMinHours, totalMaxHours,
    totalMinBusinessDays, totalMaxBusinessDays,
    confidence, confidenceScore: score,
    complexity, phaseBreakdown: phases,
    assumptions, risks, dependencies, missingData,
    suggestedSlaMinutes: slaMin,
    generatedAt: t, lastRecalculatedAt: t,
    generatedBy: "SYSTEM_ESTIMATOR",
    manuallyAdjusted: false,
    appliedRules,
  };
}

/** Construye TicketEstimateInput a partir de una fila de incidents */
export function buildInputFromIncidentRow(row: {
  id: string;
  message: string;
  sap_module: string | null;
  environment: string | null;
  confidence: string | null;
  attachments: unknown;
}): TicketEstimateInput {
  const env = (row.environment || "NO_INFORMADO").toUpperCase() as EnvironmentLevel;
  const hasAtt = Array.isArray(row.attachments) && (row.attachments as unknown[]).length > 0;
  return {
    ticketId: row.id,
    origin: "agent_chat",
    kind: "incident",
    title: row.message.slice(0, 80),
    description: row.message,
    sapModule: row.sap_module || undefined,
    environment: env,
    isProductive: env === "PRD",
    agentConfidence: row.confidence,
    hasErrorEvidence: hasAtt,
  };
}
