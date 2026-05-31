// Escalation N2 backend service.
// Persistencia real en Postgres del Centro de Escalamiento Nivel 2.
// Reemplaza el localStorage del frontend.
//
// Patrón: ensureSchema() idempotente + seed cuando las tablas están vacías.
// Mismo estilo que training.service.ts y feedback.service.ts.

import { query } from "../database/db";
import { logger } from "../utils/logger";

let schemaEnsured = false;
let seeded = false;

// ============================================================================
// Tipos (mirror de los del frontend)
// ============================================================================

export type EscalationStatus =
  | "NEW" | "REVIEW_REQUIRED" | "READY_TO_ESCALATE" | "ESCALATED"
  | "ASSIGNED_TO_N2" | "IN_PROGRESS_N2" | "RESOLVED_BY_N2"
  | "RETURNED_TO_N1" | "CANCELLED";

export type EscalationChannel =
  | "JIRA" | "SERVICENOW" | "SAP_CLOUD_ALM_FUTURE"
  | "EMAIL_FUTURE" | "TEAMS_FUTURE" | "MANUAL";

export type AssignmentStrategy =
  | "BY_MODULE" | "BY_CLIENT" | "BY_SEVERITY" | "BY_AVAILABILITY"
  | "BY_WORKLOAD" | "ROUND_ROBIN" | "MANUAL" | "FIXED_PERSON";

export type N2AvailabilityStatus =
  | "AVAILABLE" | "BUSY" | "OFFLINE" | "ON_CALL" | "VACATION";

export type N2Role =
  | "N2_FUNCTIONAL_CONSULTANT" | "N2_TECHNICAL_CONSULTANT"
  | "N2_INTEGRATION_SPECIALIST" | "N2_BTP_SPECIALIST"
  | "N2_ABAP_SPECIALIST" | "N2_SERVICE_LEAD" | "N2_ARCHITECT";

export type ItsmMode = "DEMO" | "REAL" | "FUTURE";

export interface EscalationCondition {
  sapModule?: string;
  process?: string;
  client?: string;
  environment?: string;
  severity?: string;
  confidenceBelow?: number;
  keywords?: string[];
  serviceLevel?: string;
  role?: string;
  repeatedIncident?: boolean;
  businessImpact?: string;
  technicalImpact?: string;
  noSolutionFound?: boolean;
  agentRecommendedEscalation?: boolean;
}

export interface EscalationRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  conditions: EscalationCondition;
  targetLevel: 2 | 3;
  assignmentStrategy: AssignmentStrategy;
  targetTeam?: string | null;
  targetRole?: N2Role | null;
  targetUserId?: string | null;
  channel: EscalationChannel;
  slaMinutes: number;
  requiresApproval: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface N2Responsible {
  id: string;
  name: string;
  email: string;
  role: N2Role;
  team: string;
  sapModules: string[];
  processes: string[];
  clients: string[];
  countries: string[];
  serviceLevels: string[];
  availabilityStatus: N2AvailabilityStatus;
  workingHours: string;
  timezone: string;
  maxActiveCases: number;
  currentActiveCases: number;
  skills: string[];
  jiraAccountId?: string | null;
  serviceNowUserId?: string | null;
  teamsUserId?: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EscalationEvent {
  type: string;
  at: string;
  by: string;
  note?: string;
}

export interface EscalationRecord {
  id: string;
  incidentId: string;
  escalationNumber: string;
  fromLevel: 1 | 2;
  toLevel: 2 | 3;
  reason: string;
  summary: string;
  clientSummary?: string | null;
  assignedTo?: string | null;
  assignedToName?: string | null;
  assignedTeam?: string | null;
  channel: EscalationChannel;
  ruleId?: string | null;
  externalTicketId?: string | null;
  externalTicketUrl?: string | null;
  status: EscalationStatus;
  slaTarget: string;
  slaMinutes: number;
  createdBy: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  requiresApproval: boolean;
  mode: ItsmMode;
  payload?: unknown;
  events: EscalationEvent[];
  /** Autoestimación copiada del incidente al escalar (puede ser recalculada por N2). */
  estimatedResolution?: unknown;
  /** Snapshot original al momento de la escalación, para mostrar diff N1↔N2. */
  estimatedResolutionOriginal?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface JiraConnectorConfig {
  enabled: boolean;
  mode: ItsmMode;
  baseUrl: string;
  projectKey: string;
  issueType: string;
  defaultPriority: string;
  authConfigured: boolean;
  userEmail?: string;
  apiTokenConfigured: boolean;
  defaultAssigneeAccountId?: string;
  labels: string[];
  components: string[];
}

export interface ServiceNowConnectorConfig {
  enabled: boolean;
  mode: ItsmMode;
  instanceUrl: string;
  table: string;
  assignmentGroup: string;
  defaultPriority: string;
  authConfigured: boolean;
  username?: string;
  tokenConfigured: boolean;
}

export interface SapCloudAlmConnectorConfig {
  enabled: boolean;
  mode: "FUTURE";
  endpoint: string;
  note: string;
}

export interface ItsmConnectorConfig {
  jira: JiraConnectorConfig;
  serviceNow: ServiceNowConnectorConfig;
  sapCloudAlm: SapCloudAlmConnectorConfig;
  manualEnabled: boolean;
}

export interface EscalationSettings {
  requiresApprovalDefault: boolean;
  allowAutoEscalationInDemo: boolean;
  defaultChannel: EscalationChannel;
  defaultTargetLevel: 2 | 3;
  slaBySeverity: Record<string, number>;
  useAvailabilityForAssignment: boolean;
  useWorkloadForAssignment: boolean;
  notifyClientOnEscalation: boolean;
  autoCreateEscalationDocument: boolean;
  autoCreateKnowledgeIfResolved: boolean;
  autoCreateRcaIfCritical: boolean;
}

// ============================================================================
// Schema
// ============================================================================

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS escalation_rules (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        description          TEXT NOT NULL DEFAULT '',
        enabled              BOOLEAN NOT NULL DEFAULT true,
        priority             INTEGER NOT NULL DEFAULT 5,
        conditions           JSONB NOT NULL DEFAULT '{}'::jsonb,
        target_level         INTEGER NOT NULL DEFAULT 2 CHECK (target_level IN (2,3)),
        assignment_strategy  TEXT NOT NULL,
        target_team          TEXT,
        target_role          TEXT,
        target_user_id       TEXT,
        channel              TEXT NOT NULL,
        sla_minutes          INTEGER NOT NULL DEFAULT 240,
        requires_approval    BOOLEAN NOT NULL DEFAULT true,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_esc_rules_enabled  ON escalation_rules(enabled);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_esc_rules_priority ON escalation_rules(priority);`);

    await query(`
      CREATE TABLE IF NOT EXISTS n2_responsibles (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        email                TEXT NOT NULL,
        role                 TEXT NOT NULL,
        team                 TEXT NOT NULL DEFAULT 'AMS',
        sap_modules          TEXT[] NOT NULL DEFAULT '{}'::text[],
        processes            TEXT[] NOT NULL DEFAULT '{}'::text[],
        clients              TEXT[] NOT NULL DEFAULT '{}'::text[],
        countries            TEXT[] NOT NULL DEFAULT '{}'::text[],
        service_levels       TEXT[] NOT NULL DEFAULT '{}'::text[],
        availability_status  TEXT NOT NULL DEFAULT 'AVAILABLE',
        working_hours        TEXT NOT NULL DEFAULT '08:00-18:00',
        timezone             TEXT NOT NULL DEFAULT 'America/Santiago',
        max_active_cases     INTEGER NOT NULL DEFAULT 8,
        current_active_cases INTEGER NOT NULL DEFAULT 0,
        skills               TEXT[] NOT NULL DEFAULT '{}'::text[],
        jira_account_id      TEXT,
        service_now_user_id  TEXT,
        teams_user_id        TEXT,
        active               BOOLEAN NOT NULL DEFAULT true,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_n2_resp_active ON n2_responsibles(active);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_n2_resp_avail  ON n2_responsibles(availability_status);`);

    await query(`
      CREATE TABLE IF NOT EXISTS escalation_records (
        id                  TEXT PRIMARY KEY,
        incident_id         TEXT NOT NULL,
        escalation_number   TEXT NOT NULL UNIQUE,
        from_level          INTEGER NOT NULL DEFAULT 1,
        to_level            INTEGER NOT NULL DEFAULT 2,
        reason              TEXT NOT NULL DEFAULT '',
        summary             TEXT NOT NULL DEFAULT '',
        client_summary      TEXT,
        assigned_to         TEXT,
        assigned_to_name    TEXT,
        assigned_team       TEXT,
        channel             TEXT NOT NULL,
        rule_id             TEXT,
        external_ticket_id  TEXT,
        external_ticket_url TEXT,
        status              TEXT NOT NULL,
        sla_target          TIMESTAMPTZ NOT NULL,
        sla_minutes         INTEGER NOT NULL DEFAULT 240,
        created_by          TEXT NOT NULL,
        approved_by         TEXT,
        approved_at         TIMESTAMPTZ,
        requires_approval   BOOLEAN NOT NULL DEFAULT true,
        mode                TEXT NOT NULL DEFAULT 'DEMO',
        payload             JSONB,
        events              JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_esc_rec_incident ON escalation_records(incident_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_esc_rec_status   ON escalation_records(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_esc_rec_created  ON escalation_records(created_at DESC);`);

    await query(`
      CREATE TABLE IF NOT EXISTS itsm_connectors (
        id      INTEGER PRIMARY KEY DEFAULT 1,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (id = 1)
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS escalation_settings (
        id      INTEGER PRIMARY KEY DEFAULT 1,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (id = 1)
      );
    `);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure escalation schema failed");
  }
}

// ============================================================================
// Seed
// ============================================================================

const NOW = "2026-05-30T10:00:00.000Z";

function seedResponsibles(): N2Responsible[] {
  return [
    { id:"n2_maria", name:"María Fernández", email:"maria.fernandez@demo.cl", role:"N2_FUNCTIONAL_CONSULTANT", team:"AMS · Procure to Pay",
      sapModules:["MM","ARIBA"], processes:["Procure to Pay","Compras","Recepción"], clients:["Cliente Norte","Cliente Sur"],
      countries:["CL","PE"], serviceLevels:["STANDARD","PREMIUM","ENTERPRISE"],
      availabilityStatus:"AVAILABLE", workingHours:"08:00-18:00 CLT", timezone:"America/Santiago",
      maxActiveCases:8, currentActiveCases:3, skills:["MIGO","MIRO","MM01","ME21N","Ariba P2P"],
      jiraAccountId:"557058:demo-maria", serviceNowUserId:"user.maria.demo", teamsUserId:"maria.fernandez@demo.cl",
      active:true, createdAt:NOW, updatedAt:NOW },
    { id:"n2_carlos", name:"Carlos Rivas", email:"carlos.rivas@demo.cl", role:"N2_FUNCTIONAL_CONSULTANT", team:"AMS · Order to Cash",
      sapModules:["SD"], processes:["Order to Cash","Ventas","Facturación"], clients:["Cliente Norte","Cliente Andes"],
      countries:["CL","AR"], serviceLevels:["PREMIUM","ENTERPRISE"],
      availabilityStatus:"BUSY", workingHours:"09:00-19:00 CLT", timezone:"America/Santiago",
      maxActiveCases:8, currentActiveCases:7, skills:["VA01","VF01","VL01N","Pricing"],
      jiraAccountId:"557058:demo-carlos", serviceNowUserId:"user.carlos.demo",
      active:true, createdAt:NOW, updatedAt:NOW },
    { id:"n2_daniela", name:"Daniela Soto", email:"daniela.soto@demo.cl", role:"N2_FUNCTIONAL_CONSULTANT", team:"AMS · Plan to Produce",
      sapModules:["PP","QM"], processes:["Plan to Produce","Quality Management"], clients:["Cliente Industrial"],
      countries:["CL"], serviceLevels:["PREMIUM","ENTERPRISE"],
      availabilityStatus:"AVAILABLE", workingHours:"08:00-17:00 CLT", timezone:"America/Santiago",
      maxActiveCases:6, currentActiveCases:2, skills:["CO01","CO11","MRP","QM01"],
      jiraAccountId:"557058:demo-daniela", serviceNowUserId:"user.daniela.demo",
      active:true, createdAt:NOW, updatedAt:NOW },
    { id:"n2_andres", name:"Andrés Molina", email:"andres.molina@demo.cl", role:"N2_INTEGRATION_SPECIALIST", team:"AMS · Integraciones / BTP",
      sapModules:["BTP","INTEGRACION"], processes:["Integrations","Middleware","IDocs"], clients:["Cliente Norte","Cliente Sur","Cliente Industrial"],
      countries:["CL","PE","AR"], serviceLevels:["PREMIUM","ENTERPRISE"],
      availabilityStatus:"ON_CALL", workingHours:"On-call 24/7", timezone:"America/Santiago",
      maxActiveCases:10, currentActiveCases:4, skills:["BTP","CPI","IDoc","OData","REST","ABAP Proxy"],
      jiraAccountId:"557058:demo-andres", serviceNowUserId:"user.andres.demo",
      active:true, createdAt:NOW, updatedAt:NOW },
    { id:"n2_felipe", name:"Felipe Torres", email:"felipe.torres@demo.cl", role:"N2_SERVICE_LEAD", team:"AMS · Liderazgo",
      sapModules:["MM","SD","PP","QM","BTP","INTEGRACION","EWM","IBP"], processes:["Todos"], clients:["Cliente Norte","Cliente Sur","Cliente Industrial","Cliente Andes"],
      countries:["CL","PE","AR","CO"], serviceLevels:["STANDARD","PREMIUM","ENTERPRISE"],
      availabilityStatus:"AVAILABLE", workingHours:"08:00-20:00 CLT", timezone:"America/Santiago",
      maxActiveCases:15, currentActiveCases:5, skills:["Liderazgo AMS","RCA","SLA management","Stakeholders"],
      jiraAccountId:"557058:demo-felipe", serviceNowUserId:"user.felipe.demo",
      active:true, createdAt:NOW, updatedAt:NOW },
  ];
}

function seedRules(): EscalationRule[] {
  return [
    { id:"rule_p1_prd", name:"P1 productivo → Líder N2",
      description:"Cualquier severidad CRÍTICA en ambiente productivo se deriva al Service Lead.",
      enabled:true, priority:1,
      conditions:{ severity:"P1", environment:"PRD" },
      targetLevel:2, assignmentStrategy:"FIXED_PERSON",
      targetUserId:"n2_felipe", targetTeam:"AMS · Liderazgo", targetRole:"N2_SERVICE_LEAD",
      channel:"JIRA", slaMinutes:30, requiresApproval:true,
      createdAt:NOW, updatedAt:NOW },
    { id:"rule_mm_no_solution", name:"MM sin solución → Especialista MM",
      description:"Incidentes de MM sin solución encontrada por N1 → Daniela / María.",
      enabled:true, priority:2,
      conditions:{ sapModule:"MM", noSolutionFound:true },
      targetLevel:2, assignmentStrategy:"BY_MODULE",
      targetTeam:"AMS · Procure to Pay", targetRole:"N2_FUNCTIONAL_CONSULTANT",
      channel:"JIRA", slaMinutes:240, requiresApproval:false,
      createdAt:NOW, updatedAt:NOW },
    { id:"rule_low_confidence", name:"Baja confianza del agente",
      description:"Si el agente respondió con confianza < 50 → revisión humana.",
      enabled:true, priority:3,
      conditions:{ confidenceBelow:50 },
      targetLevel:2, assignmentStrategy:"BY_AVAILABILITY",
      targetRole:"N2_FUNCTIONAL_CONSULTANT",
      channel:"MANUAL", slaMinutes:480, requiresApproval:true,
      createdAt:NOW, updatedAt:NOW },
    { id:"rule_integration_error", name:"Error técnico de integración",
      description:"Integraciones con IDoc/API/OData/RFC → Andrés (BTP).",
      enabled:true, priority:2,
      conditions:{ sapModule:"INTEGRACION", keywords:["IDoc","API","OData","RFC","CPI"] },
      targetLevel:2, assignmentStrategy:"FIXED_PERSON",
      targetUserId:"n2_andres", targetTeam:"AMS · Integraciones / BTP", targetRole:"N2_INTEGRATION_SPECIALIST",
      channel:"SERVICENOW", slaMinutes:120, requiresApproval:false,
      createdAt:NOW, updatedAt:NOW },
    { id:"rule_repeated_incident", name:"Incidentes repetidos",
      description:"Si el caso ya se repitió → escalar para análisis de fondo.",
      enabled:true, priority:4,
      conditions:{ repeatedIncident:true },
      targetLevel:2, assignmentStrategy:"BY_WORKLOAD",
      targetRole:"N2_FUNCTIONAL_CONSULTANT",
      channel:"JIRA", slaMinutes:360, requiresApproval:true,
      createdAt:NOW, updatedAt:NOW },
  ];
}

function seedConnectors(): ItsmConnectorConfig {
  return {
    jira: { enabled:true, mode:"DEMO", baseUrl:"https://jira.demo.local", projectKey:"AMS", issueType:"Incident",
      defaultPriority:"High", authConfigured:false, userEmail:"", apiTokenConfigured:false, defaultAssigneeAccountId:"",
      labels:["ams","sap","nivel2"], components:["SAP MM","SAP SD","SAP PP","Integraciones"] },
    serviceNow: { enabled:true, mode:"DEMO", instanceUrl:"https://servicenow.demo.local", table:"incident",
      assignmentGroup:"SAP AMS N2", defaultPriority:"2", authConfigured:false, username:"", tokenConfigured:false },
    sapCloudAlm: { enabled:false, mode:"FUTURE", endpoint:"", note:"Integración futura. Requiere licencia SAP Cloud ALM y conector backend." },
    manualEnabled: true,
  };
}

function seedSettings(): EscalationSettings {
  return {
    requiresApprovalDefault: true,
    allowAutoEscalationInDemo: false,
    defaultChannel: "JIRA",
    defaultTargetLevel: 2,
    slaBySeverity: { P1:30, P2:120, P3:480, P4:1440 },
    useAvailabilityForAssignment: true,
    useWorkloadForAssignment: true,
    notifyClientOnEscalation: true,
    autoCreateEscalationDocument: true,
    autoCreateKnowledgeIfResolved: true,
    autoCreateRcaIfCritical: true,
  };
}

async function seedIfEmpty(): Promise<void> {
  if (seeded) return;
  try {
    const rules = await query<{ c: string }>("SELECT count(*)::text AS c FROM escalation_rules");
    if (Number(rules.rows[0]?.c || "0") === 0) {
      for (const r of seedRules()) {
        await query(
          `INSERT INTO escalation_rules (id,name,description,enabled,priority,conditions,target_level,
            assignment_strategy,target_team,target_role,target_user_id,channel,sla_minutes,requires_approval,
            created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [r.id, r.name, r.description, r.enabled, r.priority, JSON.stringify(r.conditions),
           r.targetLevel, r.assignmentStrategy, r.targetTeam || null, r.targetRole || null,
           r.targetUserId || null, r.channel, r.slaMinutes, r.requiresApproval, r.createdAt, r.updatedAt]
        );
      }
    }
    const resp = await query<{ c: string }>("SELECT count(*)::text AS c FROM n2_responsibles");
    if (Number(resp.rows[0]?.c || "0") === 0) {
      for (const r of seedResponsibles()) {
        await query(
          `INSERT INTO n2_responsibles (id,name,email,role,team,sap_modules,processes,clients,countries,
            service_levels,availability_status,working_hours,timezone,max_active_cases,current_active_cases,
            skills,jira_account_id,service_now_user_id,teams_user_id,active,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [r.id, r.name, r.email, r.role, r.team, r.sapModules, r.processes, r.clients, r.countries,
           r.serviceLevels, r.availabilityStatus, r.workingHours, r.timezone, r.maxActiveCases,
           r.currentActiveCases, r.skills, r.jiraAccountId || null, r.serviceNowUserId || null,
           r.teamsUserId || null, r.active, r.createdAt, r.updatedAt]
        );
      }
    }
    const conn = await query<{ c: string }>("SELECT count(*)::text AS c FROM itsm_connectors");
    if (Number(conn.rows[0]?.c || "0") === 0) {
      await query(`INSERT INTO itsm_connectors (id, payload) VALUES (1, $1::jsonb)`,
        [JSON.stringify(seedConnectors())]);
    }
    const set = await query<{ c: string }>("SELECT count(*)::text AS c FROM escalation_settings");
    if (Number(set.rows[0]?.c || "0") === 0) {
      await query(`INSERT INTO escalation_settings (id, payload) VALUES (1, $1::jsonb)`,
        [JSON.stringify(seedSettings())]);
    }
    seeded = true;
  } catch (err) {
    logger.warn({ err }, "seed escalation failed");
  }
}

async function ready(): Promise<void> {
  await ensureSchema();
  await seedIfEmpty();
}

// ============================================================================
// Mappers row → frontend shape
// ============================================================================

interface RuleRow {
  id: string; name: string; description: string; enabled: boolean; priority: number;
  conditions: EscalationCondition; target_level: number; assignment_strategy: string;
  target_team: string | null; target_role: string | null; target_user_id: string | null;
  channel: string; sla_minutes: number; requires_approval: boolean;
  created_at: string; updated_at: string;
}
function mapRule(r: RuleRow): EscalationRule {
  return {
    id: r.id, name: r.name, description: r.description, enabled: r.enabled, priority: r.priority,
    conditions: r.conditions || {}, targetLevel: r.target_level as 2 | 3,
    assignmentStrategy: r.assignment_strategy as AssignmentStrategy,
    targetTeam: r.target_team, targetRole: r.target_role as N2Role | null,
    targetUserId: r.target_user_id, channel: r.channel as EscalationChannel,
    slaMinutes: r.sla_minutes, requiresApproval: r.requires_approval,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface RespRow {
  id: string; name: string; email: string; role: string; team: string;
  sap_modules: string[]; processes: string[]; clients: string[]; countries: string[]; service_levels: string[];
  availability_status: string; working_hours: string; timezone: string;
  max_active_cases: number; current_active_cases: number; skills: string[];
  jira_account_id: string | null; service_now_user_id: string | null; teams_user_id: string | null;
  active: boolean; created_at: string; updated_at: string;
}
function mapResp(r: RespRow): N2Responsible {
  return {
    id: r.id, name: r.name, email: r.email, role: r.role as N2Role, team: r.team,
    sapModules: r.sap_modules, processes: r.processes, clients: r.clients,
    countries: r.countries, serviceLevels: r.service_levels,
    availabilityStatus: r.availability_status as N2AvailabilityStatus,
    workingHours: r.working_hours, timezone: r.timezone,
    maxActiveCases: r.max_active_cases, currentActiveCases: r.current_active_cases,
    skills: r.skills, jiraAccountId: r.jira_account_id,
    serviceNowUserId: r.service_now_user_id, teamsUserId: r.teams_user_id,
    active: r.active, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface RecRow {
  id: string; incident_id: string; escalation_number: string;
  from_level: number; to_level: number; reason: string; summary: string; client_summary: string | null;
  assigned_to: string | null; assigned_to_name: string | null; assigned_team: string | null;
  channel: string; rule_id: string | null;
  external_ticket_id: string | null; external_ticket_url: string | null;
  status: string; sla_target: string; sla_minutes: number; created_by: string;
  approved_by: string | null; approved_at: string | null; requires_approval: boolean;
  mode: string; payload: unknown; events: EscalationEvent[];
  created_at: string; updated_at: string;
}
function mapRecord(r: RecRow): EscalationRecord {
  // Extraer la autoestimación del payload jsonb (la metió createRecord/updateRecord).
  const pl = (r.payload && typeof r.payload === "object") ? r.payload as Record<string, unknown> : {};
  return {
    id: r.id, incidentId: r.incident_id, escalationNumber: r.escalation_number,
    fromLevel: r.from_level as 1 | 2, toLevel: r.to_level as 2 | 3,
    reason: r.reason, summary: r.summary, clientSummary: r.client_summary,
    assignedTo: r.assigned_to, assignedToName: r.assigned_to_name, assignedTeam: r.assigned_team,
    channel: r.channel as EscalationChannel, ruleId: r.rule_id,
    externalTicketId: r.external_ticket_id, externalTicketUrl: r.external_ticket_url,
    status: r.status as EscalationStatus, slaTarget: r.sla_target, slaMinutes: r.sla_minutes,
    createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: r.approved_at,
    requiresApproval: r.requires_approval, mode: r.mode as ItsmMode,
    payload: r.payload, events: Array.isArray(r.events) ? r.events : [],
    estimatedResolution: pl.estimatedResolution ?? null,
    estimatedResolutionOriginal: pl.estimatedResolutionOriginal ?? null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ============================================================================
// Snapshot
// ============================================================================

export async function getSnapshot(): Promise<{
  rules: EscalationRule[];
  responsibles: N2Responsible[];
  records: EscalationRecord[];
  connectors: ItsmConnectorConfig;
  settings: EscalationSettings;
}> {
  await ready();
  const [rR, rsR, recR, conR, setR] = await Promise.all([
    query<RuleRow>("SELECT * FROM escalation_rules ORDER BY priority, created_at"),
    query<RespRow>("SELECT * FROM n2_responsibles ORDER BY name"),
    query<RecRow>("SELECT * FROM escalation_records ORDER BY created_at DESC LIMIT 500"),
    query<{ payload: ItsmConnectorConfig }>("SELECT payload FROM itsm_connectors WHERE id = 1"),
    query<{ payload: EscalationSettings }>("SELECT payload FROM escalation_settings WHERE id = 1"),
  ]);
  return {
    rules: rR.rows.map(mapRule),
    responsibles: rsR.rows.map(mapResp),
    records: recR.rows.map(mapRecord),
    connectors: conR.rows[0]?.payload || seedConnectors(),
    settings: setR.rows[0]?.payload || seedSettings(),
  };
}

// ============================================================================
// Rules CRUD
// ============================================================================

export async function upsertRule(r: EscalationRule): Promise<EscalationRule> {
  await ready();
  const now = new Date().toISOString();
  const res = await query<RuleRow>(
    `INSERT INTO escalation_rules (id,name,description,enabled,priority,conditions,target_level,
       assignment_strategy,target_team,target_role,target_user_id,channel,sla_minutes,requires_approval,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, description=EXCLUDED.description, enabled=EXCLUDED.enabled,
       priority=EXCLUDED.priority, conditions=EXCLUDED.conditions, target_level=EXCLUDED.target_level,
       assignment_strategy=EXCLUDED.assignment_strategy, target_team=EXCLUDED.target_team,
       target_role=EXCLUDED.target_role, target_user_id=EXCLUDED.target_user_id, channel=EXCLUDED.channel,
       sla_minutes=EXCLUDED.sla_minutes, requires_approval=EXCLUDED.requires_approval,
       updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [r.id, r.name, r.description, r.enabled, r.priority, JSON.stringify(r.conditions || {}),
     r.targetLevel, r.assignmentStrategy, r.targetTeam || null, r.targetRole || null,
     r.targetUserId || null, r.channel, r.slaMinutes, r.requiresApproval,
     r.createdAt || now, now]
  );
  return mapRule(res.rows[0]);
}

export async function deleteRule(id: string): Promise<void> {
  await ready();
  await query("DELETE FROM escalation_rules WHERE id = $1", [id]);
}

// ============================================================================
// Responsibles CRUD
// ============================================================================

export async function upsertResponsible(r: N2Responsible): Promise<N2Responsible> {
  await ready();
  const now = new Date().toISOString();
  const res = await query<RespRow>(
    `INSERT INTO n2_responsibles (id,name,email,role,team,sap_modules,processes,clients,countries,service_levels,
       availability_status,working_hours,timezone,max_active_cases,current_active_cases,skills,
       jira_account_id,service_now_user_id,teams_user_id,active,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, email=EXCLUDED.email, role=EXCLUDED.role, team=EXCLUDED.team,
       sap_modules=EXCLUDED.sap_modules, processes=EXCLUDED.processes, clients=EXCLUDED.clients,
       countries=EXCLUDED.countries, service_levels=EXCLUDED.service_levels,
       availability_status=EXCLUDED.availability_status, working_hours=EXCLUDED.working_hours,
       timezone=EXCLUDED.timezone, max_active_cases=EXCLUDED.max_active_cases,
       current_active_cases=EXCLUDED.current_active_cases, skills=EXCLUDED.skills,
       jira_account_id=EXCLUDED.jira_account_id, service_now_user_id=EXCLUDED.service_now_user_id,
       teams_user_id=EXCLUDED.teams_user_id, active=EXCLUDED.active, updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [r.id, r.name, r.email, r.role, r.team, r.sapModules, r.processes, r.clients, r.countries,
     r.serviceLevels, r.availabilityStatus, r.workingHours, r.timezone, r.maxActiveCases,
     r.currentActiveCases, r.skills, r.jiraAccountId || null, r.serviceNowUserId || null,
     r.teamsUserId || null, r.active, r.createdAt || now, now]
  );
  return mapResp(res.rows[0]);
}

export async function deleteResponsible(id: string): Promise<void> {
  await ready();
  await query("DELETE FROM n2_responsibles WHERE id = $1", [id]);
}

// ============================================================================
// Records CRUD
// ============================================================================

export async function createRecord(r: EscalationRecord): Promise<EscalationRecord> {
  await ready();

  // Copiar la estimación del incidente al payload del record si existe.
  // Esto deja la estimación adjunta al escalation para que la UI N2 pueda
  // mostrar diff cuando ajusten complejidad/severidad y se recalcule.
  let payloadOut = r.payload as Record<string, unknown> | null | undefined;
  try {
    const incEst = await query<{ estimated_resolution: unknown }>(
      "SELECT estimated_resolution FROM incidents WHERE id = $1",
      [r.incidentId]
    );
    const est = incEst.rows[0]?.estimated_resolution;
    if (est) {
      payloadOut = {
        ...(payloadOut || {}),
        estimatedResolution: est,
        estimatedResolutionOriginal: est, // baseline para diff cuando recalculen
      };
    }
  } catch { /* tabla incidents puede no existir en tests aislados */ }

  const res = await query<RecRow>(
    `INSERT INTO escalation_records (id,incident_id,escalation_number,from_level,to_level,reason,summary,
       client_summary,assigned_to,assigned_to_name,assigned_team,channel,rule_id,external_ticket_id,
       external_ticket_url,status,sla_target,sla_minutes,created_by,approved_by,approved_at,requires_approval,
       mode,payload,events,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26,$27)
     RETURNING *`,
    [r.id, r.incidentId, r.escalationNumber, r.fromLevel, r.toLevel, r.reason, r.summary,
     r.clientSummary || null, r.assignedTo || null, r.assignedToName || null, r.assignedTeam || null,
     r.channel, r.ruleId || null, r.externalTicketId || null, r.externalTicketUrl || null,
     r.status, r.slaTarget, r.slaMinutes, r.createdBy, r.approvedBy || null, r.approvedAt || null,
     r.requiresApproval, r.mode, payloadOut ? JSON.stringify(payloadOut) : null,
     JSON.stringify(r.events || []), r.createdAt, r.updatedAt]
  );
  return mapRecord(res.rows[0]);
}

export async function updateRecord(id: string, patch: Partial<EscalationRecord>): Promise<EscalationRecord | null> {
  await ready();
  const cur = await query<RecRow>("SELECT * FROM escalation_records WHERE id = $1", [id]);
  if (cur.rowCount === 0) return null;
  const merged = { ...mapRecord(cur.rows[0]), ...patch, updatedAt: new Date().toISOString() } as EscalationRecord;
  const res = await query<RecRow>(
    `UPDATE escalation_records SET
       status=$2, reason=$3, summary=$4, client_summary=$5, assigned_to=$6, assigned_to_name=$7,
       assigned_team=$8, channel=$9, external_ticket_id=$10, external_ticket_url=$11,
       approved_by=$12, approved_at=$13, payload=$14::jsonb, events=$15::jsonb, updated_at=$16
     WHERE id=$1 RETURNING *`,
    [id, merged.status, merged.reason, merged.summary, merged.clientSummary || null,
     merged.assignedTo || null, merged.assignedToName || null, merged.assignedTeam || null,
     merged.channel, merged.externalTicketId || null, merged.externalTicketUrl || null,
     merged.approvedBy || null, merged.approvedAt || null,
     merged.payload ? JSON.stringify(merged.payload) : null,
     JSON.stringify(merged.events || []), merged.updatedAt]
  );
  return mapRecord(res.rows[0]);
}

// ============================================================================
// Connectors + Settings
// ============================================================================

export async function updateConnectors(patch: Partial<ItsmConnectorConfig>): Promise<ItsmConnectorConfig> {
  await ready();
  const cur = await query<{ payload: ItsmConnectorConfig }>("SELECT payload FROM itsm_connectors WHERE id = 1");
  const merged = { ...(cur.rows[0]?.payload || seedConnectors()), ...patch };
  await query("UPDATE itsm_connectors SET payload = $1::jsonb, updated_at = now() WHERE id = 1",
    [JSON.stringify(merged)]);
  return merged;
}

export async function updateSettings(patch: Partial<EscalationSettings>): Promise<EscalationSettings> {
  await ready();
  const cur = await query<{ payload: EscalationSettings }>("SELECT payload FROM escalation_settings WHERE id = 1");
  const merged = { ...(cur.rows[0]?.payload || seedSettings()), ...patch };
  await query("UPDATE escalation_settings SET payload = $1::jsonb, updated_at = now() WHERE id = 1",
    [JSON.stringify(merged)]);
  return merged;
}

// ============================================================================
// Reset demo data
// ============================================================================

export async function resetDemoData(): Promise<void> {
  await ensureSchema();
  await query("DELETE FROM escalation_records");
  await query("DELETE FROM escalation_rules");
  await query("DELETE FROM n2_responsibles");
  await query("DELETE FROM itsm_connectors");
  await query("DELETE FROM escalation_settings");
  seeded = false;
  await seedIfEmpty();
}
