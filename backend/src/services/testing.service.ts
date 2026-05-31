// Testing Intelligence SAP backend service.
// Persistencia real en Postgres + filesystem para videos (/app/uploads/testing/{scenarioId}/).
// Reemplaza el localStorage del frontend.
//
// Patrón idéntico a escalation.service.ts y training.service.ts:
// ensureSchema() idempotente + seed cuando vacío + offline-first en frontend.

import { promises as fs } from "fs";
import { join } from "path";
import { query } from "../database/db";
import { logger } from "../utils/logger";

let schemaEnsured = false;
let seeded = false;

// ============================================================================
// Tipos (mirror del frontend)
// ============================================================================

export type TestingType =
  | "UNIT_TEST" | "SIT" | "UAT" | "REGRESSION" | "SMOKE_TEST"
  | "INTEGRATION_TEST" | "PERFORMANCE_TEST" | "SECURITY_TEST"
  | "HYPERCARE_VALIDATION" | "AMS_REPRODUCTION";

export type TestingStatus =
  | "DRAFT" | "READY" | "IN_RECORDING" | "RECORDED"
  | "SCRIPT_GENERATED" | "IN_EXECUTION" | "PASSED" | "FAILED"
  | "BLOCKED" | "NEEDS_REWORK" | "APPROVED" | "EXPORTED";

export type TestingResult = "PASS" | "FAIL" | "BLOCKED" | "PENDING";

export type EvidenceType =
  | "SCREEN_RECORDING" | "UPLOADED_VIDEO" | "SCREENSHOT"
  | "NOTE" | "FILE" | "LINK" | "LOG";

export type DefectStatus =
  | "OPEN" | "IN_PROGRESS" | "RESOLVED" | "RETEST" | "CLOSED" | "REJECTED";

export interface TestStep {
  id: string;
  order: number;
  action: string;
  data?: string;
  expectedResult: string;
  actualResult?: string;
  evidenceRequired?: boolean;
  evidenceIds?: string[];
  notes?: string;
  status?: "PASS" | "FAIL" | "BLOCKED" | "PENDING";
}

export interface TestingScenario {
  id: string;
  title: string;
  description: string;
  sapModule: string;
  process: string;
  subProcess?: string;
  scopeItemIds: string[];
  testType: TestingType;
  environment: string;
  status: TestingStatus;
  result?: TestingResult;
  owner: string;
  prerequisites: string;
  testData: string;
  steps: TestStep[];
  expectedResult: string;
  actualResult?: string;
  evidenceIds: string[];
  defectIds: string[];
  generatedScript?: string;
  generatedManual?: string;
  cloudAlmReady: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceItem {
  id: string;
  scenarioId: string;
  stepId?: string;
  type: EvidenceType;
  title: string;
  description?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  durationSeconds?: number;
  // Filesystem path relativo en el contenedor (ej. "scenarioId/abc.webm").
  // El frontend NO lo usa directamente; usa el endpoint GET /api/testing/evidences/:id/file.
  storagePath?: string | null;
  externalUrl?: string;
  noteText?: string;
  createdAt: string;
  createdBy: string;
  tags: string[];
}

export interface TestDefect {
  id: string;
  scenarioId: string;
  title: string;
  description: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  priority: "P1" | "P2" | "P3" | "P4";
  status: DefectStatus;
  assignedTo?: string;
  evidenceIds: string[];
  stepsToReproduce: string;
  expectedResult: string;
  actualResult: string;
  jiraTicketId?: string;
  cloudAlmTicketId?: string;
  convertedToIncidentId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface GeneratedUserManual {
  id: string;
  scenarioId: string;
  title: string;
  objective: string;
  audience: string;
  prerequisites: string;
  steps: { order: number; description: string; screenshot?: string }[];
  expectedResult: string;
  commonErrors: string[];
  faqs: { q: string; a: string }[];
  evidenceIds: string[];
  supportContact: string;
  language: "es" | "en" | "pt";
  contentMarkdown: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestingSettings {
  requireEvidenceToApprove: boolean;
  requireOwner: boolean;
  requireScopeItem: boolean;
  allowScreenRecording: boolean;
  allowVideoUpload: boolean;
  exportFormat: "MARKDOWN" | "JSON" | "BOTH";
  manualLanguage: "es" | "en" | "pt";
  defaultTemplate: "STANDARD" | "DETAILED" | "COMPACT";
  demoMode: boolean;
  warnSensitiveData: boolean;
}

// ============================================================================
// Filesystem helpers
// ============================================================================

const UPLOADS_ROOT = process.env.TESTING_UPLOADS_DIR || "/app/uploads/testing";

async function ensureScenarioDir(scenarioId: string): Promise<string> {
  const safe = scenarioId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = join(UPLOADS_ROOT, safe);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function safeName(original?: string): string {
  const base = (original || "evidence").replace(/[^a-zA-Z0-9._-]/g, "_");
  return base.length > 0 ? base : "evidence";
}

export async function saveUploadedFile(scenarioId: string, fileName: string, buffer: Buffer): Promise<string> {
  const dir = await ensureScenarioDir(scenarioId);
  const safe = safeName(fileName);
  const final = `${Date.now()}_${safe}`;
  const full = join(dir, final);
  await fs.writeFile(full, buffer);
  // Devuelve path relativo respecto a UPLOADS_ROOT para guardar en DB.
  return `${scenarioId.replace(/[^a-zA-Z0-9_-]/g, "_")}/${final}`;
}

export async function readEvidenceFile(storagePath: string): Promise<Buffer> {
  // Sanitización agresiva: nada de "..", nada de /, sólo subdirectorios y archivos esperados.
  if (!storagePath || storagePath.includes("..") || storagePath.startsWith("/")) {
    throw new Error("invalid storagePath");
  }
  const full = join(UPLOADS_ROOT, storagePath);
  return fs.readFile(full);
}

async function deleteEvidenceFile(storagePath: string | null | undefined): Promise<void> {
  if (!storagePath) return;
  try {
    const full = join(UPLOADS_ROOT, storagePath);
    await fs.unlink(full);
  } catch (err) {
    logger.debug({ err, storagePath }, "evidence file delete skipped");
  }
}

// ============================================================================
// Schema
// ============================================================================

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS testing_scenarios (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL,
        description       TEXT NOT NULL DEFAULT '',
        sap_module        TEXT NOT NULL DEFAULT 'CROSS',
        process           TEXT NOT NULL DEFAULT 'Cross',
        sub_process       TEXT,
        scope_item_ids    TEXT[] NOT NULL DEFAULT '{}'::text[],
        test_type         TEXT NOT NULL DEFAULT 'UAT',
        environment       TEXT NOT NULL DEFAULT 'QA',
        status            TEXT NOT NULL DEFAULT 'DRAFT',
        result            TEXT,
        owner             TEXT NOT NULL DEFAULT 'demo',
        prerequisites     TEXT NOT NULL DEFAULT '',
        test_data         TEXT NOT NULL DEFAULT '',
        steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected_result   TEXT NOT NULL DEFAULT '',
        actual_result     TEXT,
        evidence_ids      TEXT[] NOT NULL DEFAULT '{}'::text[],
        defect_ids        TEXT[] NOT NULL DEFAULT '{}'::text[],
        generated_script  TEXT,
        generated_manual  TEXT,
        cloud_alm_ready   BOOLEAN NOT NULL DEFAULT false,
        tags              TEXT[] NOT NULL DEFAULT '{}'::text[],
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_scen_module  ON testing_scenarios(sap_module);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_scen_status  ON testing_scenarios(status);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_scen_updated ON testing_scenarios(updated_at DESC);`);

    await query(`
      CREATE TABLE IF NOT EXISTS testing_evidences (
        id               TEXT PRIMARY KEY,
        scenario_id      TEXT NOT NULL REFERENCES testing_scenarios(id) ON DELETE CASCADE,
        step_id          TEXT,
        type             TEXT NOT NULL,
        title            TEXT NOT NULL,
        description      TEXT,
        file_name        TEXT,
        file_type        TEXT,
        file_size        BIGINT,
        duration_seconds INTEGER,
        storage_path     TEXT,
        external_url     TEXT,
        note_text        TEXT,
        tags             TEXT[] NOT NULL DEFAULT '{}'::text[],
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by       TEXT NOT NULL DEFAULT 'demo'
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_ev_scenario ON testing_evidences(scenario_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_ev_type     ON testing_evidences(type);`);

    await query(`
      CREATE TABLE IF NOT EXISTS testing_defects (
        id                       TEXT PRIMARY KEY,
        scenario_id              TEXT NOT NULL REFERENCES testing_scenarios(id) ON DELETE CASCADE,
        title                    TEXT NOT NULL,
        description              TEXT NOT NULL DEFAULT '',
        severity                 TEXT NOT NULL DEFAULT 'MEDIUM',
        priority                 TEXT NOT NULL DEFAULT 'P3',
        status                   TEXT NOT NULL DEFAULT 'OPEN',
        assigned_to              TEXT,
        evidence_ids             TEXT[] NOT NULL DEFAULT '{}'::text[],
        steps_to_reproduce       TEXT NOT NULL DEFAULT '',
        expected_result          TEXT NOT NULL DEFAULT '',
        actual_result            TEXT NOT NULL DEFAULT '',
        jira_ticket_id           TEXT,
        cloud_alm_ticket_id      TEXT,
        converted_to_incident_id TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by               TEXT NOT NULL DEFAULT 'demo'
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_def_scenario ON testing_defects(scenario_id);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_def_status   ON testing_defects(status);`);

    await query(`
      CREATE TABLE IF NOT EXISTS testing_manuals (
        id                TEXT PRIMARY KEY,
        scenario_id       TEXT NOT NULL REFERENCES testing_scenarios(id) ON DELETE CASCADE,
        title             TEXT NOT NULL,
        objective         TEXT NOT NULL DEFAULT '',
        audience          TEXT NOT NULL DEFAULT '',
        prerequisites     TEXT NOT NULL DEFAULT '',
        steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
        expected_result   TEXT NOT NULL DEFAULT '',
        common_errors     TEXT[] NOT NULL DEFAULT '{}'::text[],
        faqs              JSONB NOT NULL DEFAULT '[]'::jsonb,
        evidence_ids      TEXT[] NOT NULL DEFAULT '{}'::text[],
        support_contact   TEXT NOT NULL DEFAULT '',
        language          TEXT NOT NULL DEFAULT 'es',
        content_markdown  TEXT NOT NULL DEFAULT '',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_test_man_scenario ON testing_manuals(scenario_id);`);

    await query(`
      CREATE TABLE IF NOT EXISTS testing_settings (
        id      INTEGER PRIMARY KEY DEFAULT 1,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (id = 1)
      );
    `);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure testing schema failed");
  }
}

// ============================================================================
// Seed
// ============================================================================

const NOW = "2026-05-30T10:00:00.000Z";

function seedScenarios(): TestingScenario[] {
  return [
    {
      id: "ts_mm_migo",
      title: "MM · Entrada de mercancía contra OC",
      description: "Validar que MIGO permite recepcionar contra una orden de compra abierta.",
      sapModule: "MM", process: "Procure to Pay", subProcess: "Recepción",
      scopeItemIds: ["1A0"], testType: "UAT", environment: "QA", status: "SCRIPT_GENERATED",
      result: "PENDING", owner: "consultor@demo.cl",
      prerequisites: "OC 4500001234 liberada · Material 100-100 · Planta 1000",
      testData: "OC: 4500001234 · Material: 100-100 · Planta: 1000 · Cantidad: 10 UN",
      steps: [
        { id:"s1", order:1, action:"Ingresar a SAP con usuario AMS_TEST", data:"user: AMS_TEST", expectedResult:"Sesión iniciada", evidenceRequired:false, evidenceIds:[] },
        { id:"s2", order:2, action:"Ejecutar t-code MIGO", data:"MIGO", expectedResult:"Pantalla inicial MIGO visible", evidenceRequired:true, evidenceIds:[] },
        { id:"s3", order:3, action:"Seleccionar A01 + R01 Pedido", data:"OC: 4500001234", expectedResult:"Líneas cargadas", evidenceRequired:true, evidenceIds:[] },
        { id:"s4", order:4, action:"Confirmar cantidad y centro logístico", data:"CeLog: 0001", expectedResult:"Sin errores rojos", evidenceRequired:false, evidenceIds:[] },
        { id:"s5", order:5, action:"Marcar OK y verificar", data:"", expectedResult:"Botón Verificar OK", evidenceRequired:true, evidenceIds:[] },
        { id:"s6", order:6, action:"Contabilizar", data:"", expectedResult:"Documento contabilizado", evidenceRequired:true, evidenceIds:[] },
      ],
      expectedResult: "Documento de material generado. Stock actualizado en MMBE.",
      evidenceIds: [], defectIds: [], cloudAlmReady: true,
      tags: ["MM","MIGO","Recepción","UAT"],
      createdAt: NOW, updatedAt: NOW,
    },
    {
      id: "ts_sd_pricing",
      title: "SD · Pedido de venta con pricing automático",
      description: "Validar VA01 con pricing y descuentos.",
      sapModule: "SD", process: "Order to Cash", subProcess: "Pedido de venta",
      scopeItemIds: ["BD9"], testType: "SIT", environment: "QA", status: "READY",
      result: "PENDING", owner: "consultor@demo.cl",
      prerequisites: "Cliente 10000123 activo · Material FERT-001 con lista de precios",
      testData: "Cliente: 10000123 · Material: FERT-001 · Cantidad: 100 UN",
      steps: [
        { id:"s1", order:1, action:"Ejecutar VA01", data:"Tipo OR · Org 1000", expectedResult:"Pantalla inicial pedido", evidenceRequired:true, evidenceIds:[] },
        { id:"s2", order:2, action:"Ingresar solicitante y destinatario", data:"10000123", expectedResult:"Datos cargados", evidenceRequired:false, evidenceIds:[] },
        { id:"s3", order:3, action:"Agregar posición material+cantidad", data:"FERT-001/100", expectedResult:"Precio calculado", evidenceRequired:true, evidenceIds:[] },
        { id:"s4", order:4, action:"Verificar Condiciones", data:"", expectedResult:"PR00+K005+MWST visibles", evidenceRequired:true, evidenceIds:[] },
        { id:"s5", order:5, action:"Guardar", data:"", expectedResult:"Pedido 10000XXX creado", evidenceRequired:true, evidenceIds:[] },
      ],
      expectedResult: "Pedido creado con precio neto, descuento e IVA correctos.",
      evidenceIds: [], defectIds: [], cloudAlmReady: false,
      tags: ["SD","VA01","Pricing","SIT"],
      createdAt: NOW, updatedAt: NOW,
    },
    {
      id: "ts_pp_mrp",
      title: "PP · Ejecución MRP y revisión MD04",
      description: "Validar que MD01 dispara propuestas y MD04 muestra resultados consistentes.",
      sapModule: "PP", process: "Plan to Produce",
      scopeItemIds: ["J44"], testType: "REGRESSION", environment: "DEV", status: "DRAFT",
      result: "PENDING", owner: "consultor@demo.cl",
      prerequisites: "Plan maestro cargado · BOM activa · Ruta vigente",
      testData: "Material PROD-001 · Planta 1000 · Versión 01",
      steps: [
        { id:"s1", order:1, action:"Ejecutar MD01", data:"PROD-001/1000", expectedResult:"Job MRP corre sin errores", evidenceRequired:true, evidenceIds:[] },
        { id:"s2", order:2, action:"Revisar log MRP", data:"", expectedResult:"Sin mensajes rojos", evidenceRequired:true, evidenceIds:[] },
        { id:"s3", order:3, action:"Abrir MD04", data:"PROD-001", expectedResult:"Vista propuestas y stock generada", evidenceRequired:true, evidenceIds:[] },
      ],
      expectedResult: "Propuestas generadas según necesidades.",
      evidenceIds: [], defectIds: [], cloudAlmReady: false,
      tags: ["PP","MRP","MD04","Regresión"],
      createdAt: NOW, updatedAt: NOW,
    },
    {
      id: "ts_ewm_pick",
      title: "EWM · Picking y confirmación de tarea",
      description: "Validar picking end-to-end con confirmación desde RF.",
      sapModule: "EWM", process: "Warehouse Operations",
      scopeItemIds: ["1V7"], testType: "UAT", environment: "QA", status: "RECORDED",
      result: "PENDING", owner: "consultor@demo.cl",
      prerequisites: "Entrega de salida creada · Almacén EWM 1710 · Operario con RF",
      testData: "Entrega: 80000123 · HU: 1234567890",
      steps: [
        { id:"s1", order:1, action:"Verificar warehouse task", data:"/SCWM/MON", expectedResult:"Task en abierto", evidenceRequired:true, evidenceIds:[] },
        { id:"s2", order:2, action:"Operario login RF", data:"WH_OP01", expectedResult:"Menú RF cargado", evidenceRequired:true, evidenceIds:[] },
        { id:"s3", order:3, action:"Ejecutar picking físico", data:"HU 1234567890", expectedResult:"Cantidad confirmada", evidenceRequired:true, evidenceIds:[] },
        { id:"s4", order:4, action:"Confirmar tarea RF", data:"", expectedResult:"Task en completed", evidenceRequired:true, evidenceIds:[] },
      ],
      expectedResult: "Task confirmada · stock disminuido · HU lista para despacho.",
      evidenceIds: [], defectIds: [], cloudAlmReady: true,
      tags: ["EWM","Picking","RF","UAT"],
      createdAt: NOW, updatedAt: NOW,
    },
    {
      id: "ts_int_idoc",
      title: "Integración · IDoc pedido de venta entrante",
      description: "Validar IDoc ORDERS05 entrante crea pedido de venta.",
      sapModule: "INTEGRACION", process: "Integrations",
      scopeItemIds: ["BD9","INT-001"], testType: "INTEGRATION_TEST", environment: "QA", status: "FAILED",
      result: "FAIL", owner: "andres.molina@demo.cl",
      prerequisites: "Partner profile configurado · Mapping CPI activo · Cliente externo registrado",
      testData: "IDoc tipo ORDERS05 · Mensaje ORDERS · Partner: EXT_SYS_01",
      steps: [
        { id:"s1", order:1, action:"Cliente externo envía IDoc por CPI", data:"ORDERS05", expectedResult:"IDoc llega estado 64", evidenceRequired:true, evidenceIds:[] },
        { id:"s2", order:2, action:"Procesamiento automático", data:"WE19/BD87 si falla", expectedResult:"IDoc pasa a 53", evidenceRequired:true, evidenceIds:[] },
        { id:"s3", order:3, action:"Verificar pedido en VA03", data:"", expectedResult:"Pedido con datos IDoc", evidenceRequired:true, evidenceIds:[] },
        { id:"s4", order:4, action:"ALEAUD al sistema origen", data:"", expectedResult:"IDoc saliente 03", evidenceRequired:true, evidenceIds:[] },
      ],
      expectedResult: "Pedido creado y ALEAUD enviado.",
      actualResult: "IDoc falla en paso 2 con 'Date format error'. Mapping CPI requiere ajuste.",
      evidenceIds: [], defectIds: ["td_int_001"], cloudAlmReady: true,
      tags: ["Integración","IDoc","CPI","ORDERS05"],
      createdAt: NOW, updatedAt: NOW,
    },
  ];
}

function seedEvidences(): EvidenceItem[] {
  return [
    {
      id:"ev_mm_note_001", scenarioId:"ts_mm_migo", type:"NOTE",
      title:"Resultado esperado MIGO",
      noteText:"MIGO debe mostrar 'Documento contabilizado' al final y MMBE refleja el aumento de stock.",
      createdAt:NOW, createdBy:"consultor@demo.cl", tags:["MM","esperado"],
    },
    {
      id:"ev_int_log_001", scenarioId:"ts_int_idoc", type:"LOG",
      title:"Log WE02 IDoc 0000000123",
      noteText:"STATUS: 51\nMESSAGE: 'Date format error in segment E1EDP05'\nPROCESSED_BY: BD87\nTIMESTAMP: 2026-05-30T08:15:00Z",
      createdAt:NOW, createdBy:"andres.molina@demo.cl", tags:["Integración","IDoc","error"],
    },
  ];
}

function seedDefects(): TestDefect[] {
  return [
    {
      id:"td_int_001", scenarioId:"ts_int_idoc",
      title:"IDoc ORDERS05 rechazado por formato de fecha",
      description:"El IDoc entrante falla porque el mapping CPI envía fecha YYYY-MM-DD y SAP espera YYYYMMDD.",
      severity:"HIGH", priority:"P2", status:"OPEN",
      assignedTo:"andres.molina@demo.cl", evidenceIds:["ev_int_log_001"],
      stepsToReproduce:"1. Enviar IDoc ORDERS05 desde EXT_SYS_01\n2. CPI procesa y reenvía\n3. SAP recibe pero falla en E1EDP05",
      expectedResult:"IDoc procesado en estado 53 con pedido creado",
      actualResult:"IDoc queda en 51 con 'Date format error'",
      createdAt:NOW, updatedAt:NOW, createdBy:"consultor@demo.cl",
    },
  ];
}

function seedSettings(): TestingSettings {
  return {
    requireEvidenceToApprove: true,
    requireOwner: true,
    requireScopeItem: true,
    allowScreenRecording: true,
    allowVideoUpload: true,
    exportFormat: "BOTH",
    manualLanguage: "es",
    defaultTemplate: "STANDARD",
    demoMode: true,
    warnSensitiveData: true,
  };
}

async function seedIfEmpty(): Promise<void> {
  if (seeded) return;
  try {
    const sc = await query<{ c: string }>("SELECT count(*)::text AS c FROM testing_scenarios");
    if (Number(sc.rows[0]?.c || "0") === 0) {
      for (const s of seedScenarios()) {
        await query(
          `INSERT INTO testing_scenarios (id,title,description,sap_module,process,sub_process,scope_item_ids,
             test_type,environment,status,result,owner,prerequisites,test_data,steps,expected_result,actual_result,
             evidence_ids,defect_ids,generated_script,generated_manual,cloud_alm_ready,tags,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
          [s.id, s.title, s.description, s.sapModule, s.process, s.subProcess || null,
           s.scopeItemIds, s.testType, s.environment, s.status, s.result || null, s.owner,
           s.prerequisites, s.testData, JSON.stringify(s.steps), s.expectedResult, s.actualResult || null,
           s.evidenceIds, s.defectIds, s.generatedScript || null, s.generatedManual || null,
           s.cloudAlmReady, s.tags, s.createdAt, s.updatedAt]
        );
      }
    }
    const ev = await query<{ c: string }>("SELECT count(*)::text AS c FROM testing_evidences");
    if (Number(ev.rows[0]?.c || "0") === 0) {
      for (const e of seedEvidences()) {
        await query(
          `INSERT INTO testing_evidences (id,scenario_id,step_id,type,title,description,file_name,file_type,
             file_size,duration_seconds,storage_path,external_url,note_text,tags,created_at,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [e.id, e.scenarioId, e.stepId || null, e.type, e.title, e.description || null,
           e.fileName || null, e.fileType || null, e.fileSize || null, e.durationSeconds || null,
           e.storagePath || null, e.externalUrl || null, e.noteText || null, e.tags,
           e.createdAt, e.createdBy]
        );
      }
    }
    const df = await query<{ c: string }>("SELECT count(*)::text AS c FROM testing_defects");
    if (Number(df.rows[0]?.c || "0") === 0) {
      for (const d of seedDefects()) {
        await query(
          `INSERT INTO testing_defects (id,scenario_id,title,description,severity,priority,status,assigned_to,
             evidence_ids,steps_to_reproduce,expected_result,actual_result,jira_ticket_id,cloud_alm_ticket_id,
             converted_to_incident_id,created_at,updated_at,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [d.id, d.scenarioId, d.title, d.description, d.severity, d.priority, d.status,
           d.assignedTo || null, d.evidenceIds, d.stepsToReproduce, d.expectedResult, d.actualResult,
           d.jiraTicketId || null, d.cloudAlmTicketId || null, d.convertedToIncidentId || null,
           d.createdAt, d.updatedAt, d.createdBy]
        );
      }
    }
    const st = await query<{ c: string }>("SELECT count(*)::text AS c FROM testing_settings");
    if (Number(st.rows[0]?.c || "0") === 0) {
      await query(`INSERT INTO testing_settings (id, payload) VALUES (1, $1::jsonb)`,
        [JSON.stringify(seedSettings())]);
    }
    seeded = true;
  } catch (err) {
    logger.warn({ err }, "seed testing failed");
  }
}

async function ready(): Promise<void> {
  await ensureSchema();
  await seedIfEmpty();
}

// ============================================================================
// Mappers
// ============================================================================

interface ScenarioRow {
  id: string; title: string; description: string;
  sap_module: string; process: string; sub_process: string | null;
  scope_item_ids: string[]; test_type: string; environment: string;
  status: string; result: string | null; owner: string;
  prerequisites: string; test_data: string; steps: TestStep[];
  expected_result: string; actual_result: string | null;
  evidence_ids: string[]; defect_ids: string[];
  generated_script: string | null; generated_manual: string | null;
  cloud_alm_ready: boolean; tags: string[];
  created_at: string; updated_at: string;
}
function mapScenario(r: ScenarioRow): TestingScenario {
  return {
    id: r.id, title: r.title, description: r.description,
    sapModule: r.sap_module, process: r.process, subProcess: r.sub_process ?? undefined,
    scopeItemIds: r.scope_item_ids, testType: r.test_type as TestingType,
    environment: r.environment, status: r.status as TestingStatus,
    result: (r.result || "PENDING") as TestingResult, owner: r.owner,
    prerequisites: r.prerequisites, testData: r.test_data, steps: r.steps || [],
    expectedResult: r.expected_result, actualResult: r.actual_result ?? undefined,
    evidenceIds: r.evidence_ids, defectIds: r.defect_ids,
    generatedScript: r.generated_script ?? undefined, generatedManual: r.generated_manual ?? undefined,
    cloudAlmReady: r.cloud_alm_ready, tags: r.tags,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface EvidenceRow {
  id: string; scenario_id: string; step_id: string | null;
  type: string; title: string; description: string | null;
  file_name: string | null; file_type: string | null; file_size: string | null;
  duration_seconds: number | null; storage_path: string | null;
  external_url: string | null; note_text: string | null;
  tags: string[]; created_at: string; created_by: string;
}
function mapEvidence(r: EvidenceRow): EvidenceItem {
  return {
    id: r.id, scenarioId: r.scenario_id, stepId: r.step_id ?? undefined,
    type: r.type as EvidenceType, title: r.title, description: r.description ?? undefined,
    fileName: r.file_name ?? undefined, fileType: r.file_type ?? undefined,
    fileSize: r.file_size ? Number(r.file_size) : undefined,
    durationSeconds: r.duration_seconds ?? undefined, storagePath: r.storage_path,
    externalUrl: r.external_url ?? undefined, noteText: r.note_text ?? undefined,
    tags: r.tags, createdAt: r.created_at, createdBy: r.created_by,
  };
}

interface DefectRow {
  id: string; scenario_id: string; title: string; description: string;
  severity: string; priority: string; status: string; assigned_to: string | null;
  evidence_ids: string[]; steps_to_reproduce: string;
  expected_result: string; actual_result: string;
  jira_ticket_id: string | null; cloud_alm_ticket_id: string | null;
  converted_to_incident_id: string | null;
  created_at: string; updated_at: string; created_by: string;
}
function mapDefect(r: DefectRow): TestDefect {
  return {
    id: r.id, scenarioId: r.scenario_id, title: r.title, description: r.description,
    severity: r.severity as TestDefect["severity"], priority: r.priority as TestDefect["priority"],
    status: r.status as DefectStatus, assignedTo: r.assigned_to ?? undefined,
    evidenceIds: r.evidence_ids, stepsToReproduce: r.steps_to_reproduce,
    expectedResult: r.expected_result, actualResult: r.actual_result,
    jiraTicketId: r.jira_ticket_id ?? undefined,
    cloudAlmTicketId: r.cloud_alm_ticket_id ?? undefined,
    convertedToIncidentId: r.converted_to_incident_id ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by,
  };
}

interface ManualRow {
  id: string; scenario_id: string; title: string;
  objective: string; audience: string; prerequisites: string;
  steps: GeneratedUserManual["steps"]; expected_result: string;
  common_errors: string[]; faqs: GeneratedUserManual["faqs"];
  evidence_ids: string[]; support_contact: string;
  language: string; content_markdown: string;
  created_at: string; updated_at: string;
}
function mapManual(r: ManualRow): GeneratedUserManual {
  return {
    id: r.id, scenarioId: r.scenario_id, title: r.title,
    objective: r.objective, audience: r.audience, prerequisites: r.prerequisites,
    steps: r.steps || [], expectedResult: r.expected_result,
    commonErrors: r.common_errors, faqs: r.faqs || [],
    evidenceIds: r.evidence_ids, supportContact: r.support_contact,
    language: r.language as GeneratedUserManual["language"], contentMarkdown: r.content_markdown,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ============================================================================
// Snapshot
// ============================================================================

export async function getSnapshot(): Promise<{
  scenarios: TestingScenario[];
  evidences: EvidenceItem[];
  defects: TestDefect[];
  manuals: GeneratedUserManual[];
  settings: TestingSettings;
}> {
  await ready();
  const [scR, evR, dfR, mnR, stR] = await Promise.all([
    query<ScenarioRow>("SELECT * FROM testing_scenarios ORDER BY updated_at DESC"),
    query<EvidenceRow>("SELECT * FROM testing_evidences ORDER BY created_at DESC LIMIT 1000"),
    query<DefectRow>("SELECT * FROM testing_defects ORDER BY created_at DESC LIMIT 500"),
    query<ManualRow>("SELECT * FROM testing_manuals ORDER BY updated_at DESC LIMIT 200"),
    query<{ payload: TestingSettings }>("SELECT payload FROM testing_settings WHERE id = 1"),
  ]);
  return {
    scenarios: scR.rows.map(mapScenario),
    evidences: evR.rows.map(mapEvidence),
    defects: dfR.rows.map(mapDefect),
    manuals: mnR.rows.map(mapManual),
    settings: stR.rows[0]?.payload || seedSettings(),
  };
}

// ============================================================================
// Scenarios CRUD
// ============================================================================

export async function upsertScenario(s: TestingScenario): Promise<TestingScenario> {
  await ready();
  const now = new Date().toISOString();
  const res = await query<ScenarioRow>(
    `INSERT INTO testing_scenarios (id,title,description,sap_module,process,sub_process,scope_item_ids,
       test_type,environment,status,result,owner,prerequisites,test_data,steps,expected_result,actual_result,
       evidence_ids,defect_ids,generated_script,generated_manual,cloud_alm_ready,tags,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, description=EXCLUDED.description, sap_module=EXCLUDED.sap_module,
       process=EXCLUDED.process, sub_process=EXCLUDED.sub_process, scope_item_ids=EXCLUDED.scope_item_ids,
       test_type=EXCLUDED.test_type, environment=EXCLUDED.environment, status=EXCLUDED.status,
       result=EXCLUDED.result, owner=EXCLUDED.owner, prerequisites=EXCLUDED.prerequisites,
       test_data=EXCLUDED.test_data, steps=EXCLUDED.steps, expected_result=EXCLUDED.expected_result,
       actual_result=EXCLUDED.actual_result, evidence_ids=EXCLUDED.evidence_ids,
       defect_ids=EXCLUDED.defect_ids, generated_script=EXCLUDED.generated_script,
       generated_manual=EXCLUDED.generated_manual, cloud_alm_ready=EXCLUDED.cloud_alm_ready,
       tags=EXCLUDED.tags, updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [s.id, s.title, s.description, s.sapModule, s.process, s.subProcess || null,
     s.scopeItemIds, s.testType, s.environment, s.status, s.result || null, s.owner,
     s.prerequisites, s.testData, JSON.stringify(s.steps || []), s.expectedResult,
     s.actualResult || null, s.evidenceIds || [], s.defectIds || [],
     s.generatedScript || null, s.generatedManual || null,
     s.cloudAlmReady, s.tags || [], s.createdAt || now, now]
  );
  return mapScenario(res.rows[0]);
}

export async function deleteScenario(id: string): Promise<void> {
  await ready();
  // Borrar archivos físicos asociados a evidencias del escenario
  const evs = await query<EvidenceRow>("SELECT storage_path FROM testing_evidences WHERE scenario_id = $1", [id]);
  for (const e of evs.rows) {
    await deleteEvidenceFile(e.storage_path);
  }
  await query("DELETE FROM testing_scenarios WHERE id = $1", [id]);
}

// ============================================================================
// Evidences CRUD
// ============================================================================

export async function createEvidence(e: EvidenceItem): Promise<EvidenceItem> {
  await ready();
  const res = await query<EvidenceRow>(
    `INSERT INTO testing_evidences (id,scenario_id,step_id,type,title,description,file_name,file_type,
       file_size,duration_seconds,storage_path,external_url,note_text,tags,created_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [e.id, e.scenarioId, e.stepId || null, e.type, e.title, e.description || null,
     e.fileName || null, e.fileType || null, e.fileSize || null,
     e.durationSeconds || null, e.storagePath || null,
     e.externalUrl || null, e.noteText || null, e.tags || [],
     e.createdAt, e.createdBy]
  );
  // Push al array evidence_ids del scenario
  await query(
    `UPDATE testing_scenarios SET evidence_ids = array_append(evidence_ids, $1), updated_at = now()
     WHERE id = $2 AND NOT ($1 = ANY(evidence_ids))`,
    [e.id, e.scenarioId]
  );
  return mapEvidence(res.rows[0]);
}

export async function deleteEvidence(id: string): Promise<void> {
  await ready();
  const cur = await query<EvidenceRow>("SELECT * FROM testing_evidences WHERE id = $1", [id]);
  if (cur.rowCount === 0) return;
  const ev = cur.rows[0];
  await deleteEvidenceFile(ev.storage_path);
  await query("DELETE FROM testing_evidences WHERE id = $1", [id]);
  await query(
    "UPDATE testing_scenarios SET evidence_ids = array_remove(evidence_ids, $1), updated_at = now() WHERE id = $2",
    [id, ev.scenario_id]
  );
}

export async function getEvidence(id: string): Promise<EvidenceItem | null> {
  await ready();
  const r = await query<EvidenceRow>("SELECT * FROM testing_evidences WHERE id = $1", [id]);
  return r.rowCount === 0 ? null : mapEvidence(r.rows[0]);
}

// ============================================================================
// Defects CRUD
// ============================================================================

export async function upsertDefect(d: TestDefect): Promise<TestDefect> {
  await ready();
  const now = new Date().toISOString();
  const res = await query<DefectRow>(
    `INSERT INTO testing_defects (id,scenario_id,title,description,severity,priority,status,assigned_to,
       evidence_ids,steps_to_reproduce,expected_result,actual_result,jira_ticket_id,cloud_alm_ticket_id,
       converted_to_incident_id,created_at,updated_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, description=EXCLUDED.description, severity=EXCLUDED.severity,
       priority=EXCLUDED.priority, status=EXCLUDED.status, assigned_to=EXCLUDED.assigned_to,
       evidence_ids=EXCLUDED.evidence_ids, steps_to_reproduce=EXCLUDED.steps_to_reproduce,
       expected_result=EXCLUDED.expected_result, actual_result=EXCLUDED.actual_result,
       jira_ticket_id=EXCLUDED.jira_ticket_id, cloud_alm_ticket_id=EXCLUDED.cloud_alm_ticket_id,
       converted_to_incident_id=EXCLUDED.converted_to_incident_id,
       updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [d.id, d.scenarioId, d.title, d.description, d.severity, d.priority, d.status,
     d.assignedTo || null, d.evidenceIds || [], d.stepsToReproduce, d.expectedResult, d.actualResult,
     d.jiraTicketId || null, d.cloudAlmTicketId || null, d.convertedToIncidentId || null,
     d.createdAt || now, now, d.createdBy]
  );
  await query(
    `UPDATE testing_scenarios SET defect_ids = array_append(defect_ids, $1), updated_at = now()
     WHERE id = $2 AND NOT ($1 = ANY(defect_ids))`,
    [d.id, d.scenarioId]
  );
  return mapDefect(res.rows[0]);
}

export async function deleteDefect(id: string): Promise<void> {
  await ready();
  const cur = await query<DefectRow>("SELECT * FROM testing_defects WHERE id = $1", [id]);
  if (cur.rowCount === 0) return;
  await query("DELETE FROM testing_defects WHERE id = $1", [id]);
  await query(
    "UPDATE testing_scenarios SET defect_ids = array_remove(defect_ids, $1), updated_at = now() WHERE id = $2",
    [id, cur.rows[0].scenario_id]
  );
}

// ============================================================================
// Manuals CRUD
// ============================================================================

export async function upsertManual(m: GeneratedUserManual): Promise<GeneratedUserManual> {
  await ready();
  // Política: un manual por escenario. Si ya existe, lo reemplazamos.
  await query("DELETE FROM testing_manuals WHERE scenario_id = $1 AND id <> $2", [m.scenarioId, m.id]);
  const now = new Date().toISOString();
  const res = await query<ManualRow>(
    `INSERT INTO testing_manuals (id,scenario_id,title,objective,audience,prerequisites,steps,expected_result,
       common_errors,faqs,evidence_ids,support_contact,language,content_markdown,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, objective=EXCLUDED.objective, audience=EXCLUDED.audience,
       prerequisites=EXCLUDED.prerequisites, steps=EXCLUDED.steps, expected_result=EXCLUDED.expected_result,
       common_errors=EXCLUDED.common_errors, faqs=EXCLUDED.faqs, evidence_ids=EXCLUDED.evidence_ids,
       support_contact=EXCLUDED.support_contact, language=EXCLUDED.language,
       content_markdown=EXCLUDED.content_markdown, updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [m.id, m.scenarioId, m.title, m.objective, m.audience, m.prerequisites,
     JSON.stringify(m.steps || []), m.expectedResult, m.commonErrors || [],
     JSON.stringify(m.faqs || []), m.evidenceIds || [], m.supportContact,
     m.language, m.contentMarkdown, m.createdAt || now, now]
  );
  await query(
    "UPDATE testing_scenarios SET generated_manual = $1, updated_at = now() WHERE id = $2",
    [m.contentMarkdown, m.scenarioId]
  );
  return mapManual(res.rows[0]);
}

// ============================================================================
// Settings + reset
// ============================================================================

export async function updateSettings(patch: Partial<TestingSettings>): Promise<TestingSettings> {
  await ready();
  const cur = await query<{ payload: TestingSettings }>("SELECT payload FROM testing_settings WHERE id = 1");
  const merged = { ...(cur.rows[0]?.payload || seedSettings()), ...patch };
  await query("UPDATE testing_settings SET payload = $1::jsonb, updated_at = now() WHERE id = 1",
    [JSON.stringify(merged)]);
  return merged;
}

export async function resetDemo(): Promise<void> {
  await ensureSchema();
  // Borrar archivos físicos
  const evs = await query<EvidenceRow>("SELECT storage_path FROM testing_evidences WHERE storage_path IS NOT NULL");
  for (const e of evs.rows) await deleteEvidenceFile(e.storage_path);

  await query("DELETE FROM testing_manuals");
  await query("DELETE FROM testing_defects");
  await query("DELETE FROM testing_evidences");
  await query("DELETE FROM testing_scenarios");
  await query("DELETE FROM testing_settings");
  seeded = false;
  await seedIfEmpty();
}
