// Playbooks AMS backend service.
// Persistencia real en Postgres. Reemplaza el localStorage del frontend.
// Multi-tenant: todas las funciones reciben tenantId y filtran por él (Sprint 3 ALTOS).

import { query } from "../database/db";
import { logger } from "../utils/logger";

let schemaEnsured = false;
const seededTenants = new Set<string>();

// ============================================================================
// Tipos (mirror del frontend)
// ============================================================================

export type PlaybookStatus = "DRAFT" | "ACTIVE" | "ARCHIVED" | "NEEDS_REVIEW";
export type Severity = "P1" | "P2" | "P3" | "P4";

export interface PlaybookStep {
  id: string;
  order: number;
  title: string;
  description: string;
  responsibleRole: string;
  estimatedMinutes: number;
  evidenceRequired: boolean;
  completionCriteria: string;
}

export interface AmsPlaybook {
  id: string;
  title: string;
  description: string;
  sapModule: string;
  process: string;
  severity: Severity;
  triggerWhen: string;
  steps: PlaybookStep[];
  requiredData: string[];
  responsibleRole: string;
  slaTargetMinutes: number;
  escalationRules: string;
  evidenceRequired: string[];
  communicationTemplate: string;
  relatedKnowledgeItems: string[];
  relatedScopeItems: string[];
  status: PlaybookStatus;
  version: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

export interface PlaybookExecution {
  id: string;
  playbookId: string;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  incidentId: string | null;
  completedSteps: string[];
  notes: Record<string, string>;
  status: "IN_PROGRESS" | "COMPLETED" | "ABANDONED";
}

// ============================================================================
// Schema
// ============================================================================

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS playbooks (
        id                       TEXT PRIMARY KEY,
        title                    TEXT NOT NULL,
        description              TEXT NOT NULL DEFAULT '',
        sap_module               TEXT NOT NULL DEFAULT 'CROSS',
        process                  TEXT NOT NULL DEFAULT 'Cross',
        severity                 TEXT NOT NULL DEFAULT 'P3'
                                 CHECK (severity IN ('P1','P2','P3','P4')),
        trigger_when             TEXT NOT NULL DEFAULT '',
        steps                    JSONB NOT NULL DEFAULT '[]'::jsonb,
        required_data            TEXT[] NOT NULL DEFAULT '{}'::text[],
        responsible_role         TEXT NOT NULL DEFAULT 'AMS_CONSULTANT',
        sla_target_minutes       INTEGER NOT NULL DEFAULT 240,
        escalation_rules         TEXT NOT NULL DEFAULT '',
        evidence_required        TEXT[] NOT NULL DEFAULT '{}'::text[],
        communication_template   TEXT NOT NULL DEFAULT '',
        related_knowledge_items  TEXT[] NOT NULL DEFAULT '{}'::text[],
        related_scope_items      TEXT[] NOT NULL DEFAULT '{}'::text[],
        status                   TEXT NOT NULL DEFAULT 'DRAFT'
                                 CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED','NEEDS_REVIEW')),
        version                  TEXT NOT NULL DEFAULT '1.0',
        owner                    TEXT NOT NULL DEFAULT 'demo',
        tags                     TEXT[] NOT NULL DEFAULT '{}'::text[],
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_pb_status  ON playbooks(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pb_module  ON playbooks(sap_module);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pb_updated ON playbooks(updated_at DESC);`);

    await query(`
      CREATE TABLE IF NOT EXISTS playbook_executions (
        id              TEXT PRIMARY KEY,
        playbook_id     TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at     TIMESTAMPTZ,
        started_by      TEXT NOT NULL DEFAULT 'demo',
        incident_id     TEXT,
        completed_steps TEXT[] NOT NULL DEFAULT '{}'::text[],
        notes           JSONB NOT NULL DEFAULT '{}'::jsonb,
        status          TEXT NOT NULL DEFAULT 'IN_PROGRESS'
                        CHECK (status IN ('IN_PROGRESS','COMPLETED','ABANDONED'))
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_pbe_playbook ON playbook_executions(playbook_id);`);

    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure playbooks schema failed");
  }
}

// ============================================================================
// Seed (importamos del frontend en runtime? no, replicamos aquí mínimo)
// ============================================================================

const NOW = "2026-05-30T10:00:00.000Z";

function seedPlaybooks(): AmsPlaybook[] {
  return [
    {
      id: "pb_p1", title: "Incidente P1 productivo",
      description: "Protocolo de respuesta a P1 productivo: contención, comunicación, RCA y cierre.",
      sapModule: "CROSS", process: "AMS · Crisis Management", severity: "P1",
      triggerWhen: "Cualquier incidente reportado como P1 en ambiente PRD.",
      steps: [
        { id:"s1", order:1, title:"Confirmar P1 con cliente", description:"Validar severidad real, no asumir.", responsibleRole:"SERVICE_LEAD", estimatedMinutes:5, evidenceRequired:true, completionCriteria:"Cliente confirma impacto productivo" },
        { id:"s2", order:2, title:"Crear war room", description:"Convocar especialista funcional + técnico + líder.", responsibleRole:"SERVICE_LEAD", estimatedMinutes:10, evidenceRequired:true, completionCriteria:"3+ personas conectadas" },
        { id:"s3", order:3, title:"Contención inmediata", description:"Aplicar workaround para restaurar operación.", responsibleRole:"N2_FUNCTIONAL_CONSULTANT", estimatedMinutes:60, evidenceRequired:true, completionCriteria:"Operación restaurada o vía alternativa" },
        { id:"s4", order:4, title:"Notificar avance al cliente", description:"Update cada 30 min mientras dure el P1.", responsibleRole:"SERVICE_LEAD", estimatedMinutes:5, evidenceRequired:true, completionCriteria:"Email/llamada al cliente" },
        { id:"s5", order:5, title:"RCA preliminar", description:"Identificar causa raíz inicial.", responsibleRole:"N2_FUNCTIONAL_CONSULTANT", estimatedMinutes:90, evidenceRequired:true, completionCriteria:"RCA preliminar redactada" },
        { id:"s6", order:6, title:"Cierre y minuta", description:"Documentar el caso, lecciones aprendidas.", responsibleRole:"SERVICE_LEAD", estimatedMinutes:30, evidenceRequired:true, completionCriteria:"Minuta firmada por cliente" },
      ],
      requiredData: ["Severidad","Ambiente","Cliente","Módulo SAP","Hora de inicio"],
      responsibleRole: "SERVICE_LEAD", slaTargetMinutes: 240,
      escalationRules: "Si no hay contención en 60 min → escalar a N3.",
      evidenceRequired: ["Captura del error","Log SM21","Confirmación del cliente"],
      communicationTemplate: "Hola, hemos detectado un incidente P1 en {{module}}. Estamos trabajando con el equipo N2. Próxima actualización en 30 min.",
      relatedKnowledgeItems: [], relatedScopeItems: [],
      status: "ACTIVE", version: "1.2", owner: "felipe.torres@demo.cl",
      createdAt: NOW, updatedAt: NOW, tags: ["P1","Crisis","War room"],
    },
    {
      id: "pb_mm_migo", title: "MIGO falla al contabilizar entrada",
      description: "Diagnóstico estándar cuando MIGO arroja error al contabilizar.",
      sapModule: "MM", process: "Procure to Pay · Recepción", severity: "P2",
      triggerWhen: "Usuario reporta error en MIGO al contabilizar contra OC.",
      steps: [
        { id:"s1", order:1, title:"Capturar error en pantalla", description:"Pedir screenshot del mensaje completo.", responsibleRole:"AMS_CONSULTANT", estimatedMinutes:5, evidenceRequired:true, completionCriteria:"Screenshot recibido" },
        { id:"s2", order:2, title:"Verificar OC abierta", description:"ME23N → estado de la OC, cantidad pendiente.", responsibleRole:"AMS_CONSULTANT", estimatedMinutes:10, evidenceRequired:true, completionCriteria:"OC verificada" },
        { id:"s3", order:3, title:"Revisar SM21 + ST22", description:"Buscar errores ABAP de últimas 2h.", responsibleRole:"N2_TECHNICAL_CONSULTANT", estimatedMinutes:15, evidenceRequired:true, completionCriteria:"Logs revisados" },
        { id:"s4", order:4, title:"Validar stock real vs sistema", description:"MMBE para el material.", responsibleRole:"AMS_CONSULTANT", estimatedMinutes:10, evidenceRequired:true, completionCriteria:"Stock validado" },
        { id:"s5", order:5, title:"Aplicar solución", description:"Re-contabilizar / OSS note / consultoría.", responsibleRole:"N2_FUNCTIONAL_CONSULTANT", estimatedMinutes:60, evidenceRequired:true, completionCriteria:"Documento contabilizado" },
      ],
      requiredData: ["Número OC","Material","Planta","Usuario","Mensaje error"],
      responsibleRole: "AMS_CONSULTANT", slaTargetMinutes: 360,
      escalationRules: "Si error es ABAP dump → escalar a N3 inmediato.",
      evidenceRequired: ["Screenshot MIGO","Captura ME23N","Log SM21"],
      communicationTemplate: "Hola, recibimos tu caso de MIGO. Empezamos por revisar OC y stock. Te respondemos en <SLA> min.",
      relatedKnowledgeItems: ["kn_migo_001"], relatedScopeItems: ["1A0"],
      status: "ACTIVE", version: "1.0", owner: "maria.fernandez@demo.cl",
      createdAt: NOW, updatedAt: NOW, tags: ["MM","MIGO","Recepción"],
    },
    {
      id: "pb_sd_pricing", title: "Pricing incorrecto en pedido VA01",
      description: "VA01 muestra precio distinto al esperado por el cliente.",
      sapModule: "SD", process: "Order to Cash", severity: "P3",
      triggerWhen: "Cliente reporta precio incorrecto en pedido.",
      steps: [
        { id:"s1", order:1, title:"Identificar condiciones aplicadas", description:"Botón Condiciones en la posición.", responsibleRole:"AMS_CONSULTANT", estimatedMinutes:10, evidenceRequired:true, completionCriteria:"Condiciones listadas" },
        { id:"s2", order:2, title:"Verificar registros vigentes", description:"VK13 con la fecha del pedido.", responsibleRole:"AMS_CONSULTANT", estimatedMinutes:15, evidenceRequired:true, completionCriteria:"Registros revisados" },
        { id:"s3", order:3, title:"Analizar secuencia de acceso", description:"VOK0 → análisis de pricing.", responsibleRole:"N2_FUNCTIONAL_CONSULTANT", estimatedMinutes:30, evidenceRequired:true, completionCriteria:"Diagnóstico claro" },
      ],
      requiredData: ["Pedido","Cliente","Material","Cantidad","Precio esperado"],
      responsibleRole: "AMS_CONSULTANT", slaTargetMinutes: 480,
      escalationRules: "Si involucra customizing → SERVICE_LEAD.",
      evidenceRequired: ["Captura VA02 condiciones","Análisis pricing"],
      communicationTemplate: "Recibimos tu consulta sobre el precio del pedido {{order}}. Lo revisamos.",
      relatedKnowledgeItems: [], relatedScopeItems: ["BD9"],
      status: "ACTIVE", version: "1.0", owner: "carlos.rivas@demo.cl",
      createdAt: NOW, updatedAt: NOW, tags: ["SD","Pricing"],
    },
    {
      id: "pb_pp_mrp", title: "MRP no genera propuestas esperadas",
      description: "MD01 termina sin generar las propuestas que el cliente esperaba.",
      sapModule: "PP", process: "Plan to Produce", severity: "P3",
      triggerWhen: "Resultado MRP inconsistente con expectativa.",
      steps: [
        { id:"s1", order:1, title:"Revisar log MRP", description:"En MD01 al final del run o MD06.", responsibleRole:"N2_FUNCTIONAL_CONSULTANT", estimatedMinutes:15, evidenceRequired:true, completionCriteria:"Log analizado" },
        { id:"s2", order:2, title:"Verificar maestros", description:"BOM, Routing, Material Master fields MRP1-4.", responsibleRole:"N2_FUNCTIONAL_CONSULTANT", estimatedMinutes:30, evidenceRequired:true, completionCriteria:"Maestros revisados" },
        { id:"s3", order:3, title:"Replicar en QAS", description:"Reejecutar MRP en QAS con datos espejo.", responsibleRole:"N2_FUNCTIONAL_CONSULTANT", estimatedMinutes:60, evidenceRequired:true, completionCriteria:"Replicación confirmada" },
      ],
      requiredData: ["Material","Planta","Versión MRP","Período"],
      responsibleRole: "N2_FUNCTIONAL_CONSULTANT", slaTargetMinutes: 720,
      escalationRules: "Si involucra customizing PP → SERVICE_LEAD.",
      evidenceRequired: ["Log MRP","Captura MD04","Maestros impresos"],
      communicationTemplate: "Estamos revisando el MRP de {{material}}. Te avisamos.",
      relatedKnowledgeItems: [], relatedScopeItems: ["J44"],
      status: "ACTIVE", version: "1.0", owner: "daniela.soto@demo.cl",
      createdAt: NOW, updatedAt: NOW, tags: ["PP","MRP","MD04"],
    },
    {
      id: "pb_int_idoc", title: "IDoc entrante en estado 51",
      description: "IDoc llegó pero no se procesó correctamente.",
      sapModule: "INTEGRACION", process: "Integrations", severity: "P2",
      triggerWhen: "Monitoreo detecta IDocs en estado 51 acumulados.",
      steps: [
        { id:"s1", order:1, title:"Identificar IDocs afectados", description:"WE02 con status 51 últimas 24h.", responsibleRole:"N2_INTEGRATION_SPECIALIST", estimatedMinutes:15, evidenceRequired:true, completionCriteria:"Lista de IDocs" },
        { id:"s2", order:2, title:"Analizar mensaje error", description:"Doble-click → mensajes técnicos.", responsibleRole:"N2_INTEGRATION_SPECIALIST", estimatedMinutes:15, evidenceRequired:true, completionCriteria:"Causa identificada" },
        { id:"s3", order:3, title:"Reprocesar con BD87", description:"Una vez corregido el dato/customizing.", responsibleRole:"N2_INTEGRATION_SPECIALIST", estimatedMinutes:30, evidenceRequired:true, completionCriteria:"IDoc en 53" },
      ],
      requiredData: ["IDoc number","Message type","Partner","Timestamp"],
      responsibleRole: "N2_INTEGRATION_SPECIALIST", slaTargetMinutes: 240,
      escalationRules: "Si involucra CPI → BTP team.",
      evidenceRequired: ["WE02 captura","Log SM21","BD87 resultado"],
      communicationTemplate: "Detectamos IDocs en estado 51. Estamos analizando.",
      relatedKnowledgeItems: [], relatedScopeItems: [],
      status: "ACTIVE", version: "1.0", owner: "andres.molina@demo.cl",
      createdAt: NOW, updatedAt: NOW, tags: ["Integración","IDoc","WE02"],
    },
  ];
}

async function seedIfEmpty(tenantId: string): Promise<void> {
  if (seededTenants.has(tenantId)) return;
  try {
    const c = await query<{ c: string }>(
      "SELECT count(*)::text AS c FROM playbooks WHERE tenant_id = $1",
      [tenantId]
    );
    if (Number(c.rows[0]?.c || "0") === 0) {
      for (const p of seedPlaybooks()) {
        await query(
          `INSERT INTO playbooks (tenant_id,id,title,description,sap_module,process,severity,trigger_when,steps,
             required_data,responsible_role,sla_target_minutes,escalation_rules,evidence_required,
             communication_template,related_knowledge_items,related_scope_items,status,version,owner,tags,
             created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           ON CONFLICT (id) DO NOTHING`,
          [tenantId, p.id, p.title, p.description, p.sapModule, p.process, p.severity, p.triggerWhen,
           JSON.stringify(p.steps), p.requiredData, p.responsibleRole, p.slaTargetMinutes,
           p.escalationRules, p.evidenceRequired, p.communicationTemplate,
           p.relatedKnowledgeItems, p.relatedScopeItems, p.status, p.version, p.owner,
           p.tags, p.createdAt, p.updatedAt]
        );
      }
    }
    seededTenants.add(tenantId);
  } catch (err) {
    logger.warn({ err }, "seed playbooks failed");
  }
}

async function ready(tenantId: string) { await ensureSchema(); await seedIfEmpty(tenantId); }

// ============================================================================
// Mappers
// ============================================================================

interface PbRow {
  id: string; title: string; description: string; sap_module: string; process: string;
  severity: Severity; trigger_when: string; steps: PlaybookStep[];
  required_data: string[]; responsible_role: string; sla_target_minutes: number;
  escalation_rules: string; evidence_required: string[]; communication_template: string;
  related_knowledge_items: string[]; related_scope_items: string[];
  status: PlaybookStatus; version: string; owner: string; tags: string[];
  created_at: string; updated_at: string;
}
function mapPb(r: PbRow): AmsPlaybook {
  return {
    id: r.id, title: r.title, description: r.description,
    sapModule: r.sap_module, process: r.process, severity: r.severity,
    triggerWhen: r.trigger_when, steps: r.steps || [],
    requiredData: r.required_data, responsibleRole: r.responsible_role,
    slaTargetMinutes: r.sla_target_minutes, escalationRules: r.escalation_rules,
    evidenceRequired: r.evidence_required, communicationTemplate: r.communication_template,
    relatedKnowledgeItems: r.related_knowledge_items,
    relatedScopeItems: r.related_scope_items,
    status: r.status, version: r.version, owner: r.owner, tags: r.tags,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface PbExecRow {
  id: string; playbook_id: string;
  started_at: string; finished_at: string | null;
  started_by: string; incident_id: string | null;
  completed_steps: string[]; notes: Record<string, string>;
  status: PlaybookExecution["status"];
}
function mapExec(r: PbExecRow): PlaybookExecution {
  return {
    id: r.id, playbookId: r.playbook_id,
    startedAt: r.started_at, finishedAt: r.finished_at,
    startedBy: r.started_by, incidentId: r.incident_id,
    completedSteps: r.completed_steps, notes: r.notes || {},
    status: r.status,
  };
}

// ============================================================================
// API
// ============================================================================

export async function getSnapshot(tenantId: string): Promise<{ playbooks: AmsPlaybook[]; executions: PlaybookExecution[] }> {
  await ready(tenantId);
  const [pR, eR] = await Promise.all([
    query<PbRow>(
      "SELECT * FROM playbooks WHERE tenant_id = $1 ORDER BY updated_at DESC",
      [tenantId]
    ),
    query<PbExecRow>(
      "SELECT * FROM playbook_executions WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 500",
      [tenantId]
    ),
  ]);
  return { playbooks: pR.rows.map(mapPb), executions: eR.rows.map(mapExec) };
}

export async function upsertPlaybook(tenantId: string, p: AmsPlaybook): Promise<AmsPlaybook> {
  await ready(tenantId);
  const now = new Date().toISOString();
  const res = await query<PbRow>(
    `INSERT INTO playbooks (tenant_id,id,title,description,sap_module,process,severity,trigger_when,steps,
       required_data,responsible_role,sla_target_minutes,escalation_rules,evidence_required,
       communication_template,related_knowledge_items,related_scope_items,status,version,owner,tags,
       created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, description=EXCLUDED.description, sap_module=EXCLUDED.sap_module,
       process=EXCLUDED.process, severity=EXCLUDED.severity, trigger_when=EXCLUDED.trigger_when,
       steps=EXCLUDED.steps, required_data=EXCLUDED.required_data,
       responsible_role=EXCLUDED.responsible_role, sla_target_minutes=EXCLUDED.sla_target_minutes,
       escalation_rules=EXCLUDED.escalation_rules, evidence_required=EXCLUDED.evidence_required,
       communication_template=EXCLUDED.communication_template,
       related_knowledge_items=EXCLUDED.related_knowledge_items,
       related_scope_items=EXCLUDED.related_scope_items, status=EXCLUDED.status,
       version=EXCLUDED.version, owner=EXCLUDED.owner, tags=EXCLUDED.tags,
       updated_at=EXCLUDED.updated_at
     WHERE playbooks.tenant_id = $1
     RETURNING *`,
    [tenantId, p.id, p.title, p.description, p.sapModule, p.process, p.severity, p.triggerWhen,
     JSON.stringify(p.steps || []), p.requiredData || [], p.responsibleRole, p.slaTargetMinutes,
     p.escalationRules, p.evidenceRequired || [], p.communicationTemplate,
     p.relatedKnowledgeItems || [], p.relatedScopeItems || [],
     p.status, p.version, p.owner, p.tags || [], p.createdAt || now, now]
  );
  return mapPb(res.rows[0]);
}

export async function deletePlaybook(tenantId: string, id: string): Promise<void> {
  await ready(tenantId);
  await query("DELETE FROM playbooks WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
}

export async function upsertExecution(tenantId: string, e: PlaybookExecution): Promise<PlaybookExecution> {
  await ready(tenantId);
  const res = await query<PbExecRow>(
    `INSERT INTO playbook_executions (tenant_id,id,playbook_id,started_at,finished_at,started_by,incident_id,
       completed_steps,notes,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     ON CONFLICT (id) DO UPDATE SET
       finished_at=EXCLUDED.finished_at, completed_steps=EXCLUDED.completed_steps,
       notes=EXCLUDED.notes, status=EXCLUDED.status
     WHERE playbook_executions.tenant_id = $1
     RETURNING *`,
    [tenantId, e.id, e.playbookId, e.startedAt, e.finishedAt || null, e.startedBy, e.incidentId || null,
     e.completedSteps || [], JSON.stringify(e.notes || {}), e.status]
  );
  return mapExec(res.rows[0]);
}

export async function deleteExecution(tenantId: string, id: string): Promise<void> {
  await ready(tenantId);
  await query("DELETE FROM playbook_executions WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
}

export async function resetDemo(tenantId: string): Promise<void> {
  await ensureSchema();
  await query("DELETE FROM playbook_executions WHERE tenant_id = $1", [tenantId]);
  await query("DELETE FROM playbooks WHERE tenant_id = $1", [tenantId]);
  seededTenants.delete(tenantId);
  await seedIfEmpty(tenantId);
}
