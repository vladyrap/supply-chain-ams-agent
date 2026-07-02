// =============================================================================
// agentic-apps.service.ts — v1.3 Agent Hub · Apps Agénticas
// =============================================================================
// Una app agéntica es un pipeline secuencial de agentes custom (máx 4 pasos):
//   input del usuario → paso 1 (agente A) → paso 2 (agente B, recibe output
//   de A) → … → output final.
//
// El run se ejecuta en background (setImmediate) y el frontend hace polling
// a GET /api/apps/runs/:runId — así evitamos timeouts HTTP en pipelines
// que suman varias llamadas Gemini.
// =============================================================================

import { query } from "../database/db";
import { chatWithCustomAgent, getAgent } from "./custom-agents.service";
import { logger } from "../utils/logger";

export const MAX_STEPS = 4;

export interface AppStep {
  agentId: string;
  /** Instrucción específica de este paso (qué hacer con el input recibido). */
  instruction: string;
  /** Nombre visible del paso (default: nombre del agente). */
  name?: string;
}

export interface AgenticApp {
  id: string;
  tenantId: string;
  name: string;
  category: string;
  description: string;
  objective: string;
  steps: AppStep[];
  icon: string;
  status: "active" | "archived";
  runCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StepOutput {
  stepIndex: number;
  stepName: string;
  agentId: string;
  status: "pending" | "running" | "done" | "failed";
  output: string;
  durationMs: number;
}

export interface AppRun {
  id: string;
  tenantId: string;
  appId: string;
  input: string;
  status: "running" | "done" | "failed";
  stepsOutput: StepOutput[];
  finalOutput: string;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ============================================================
// Schema
// ============================================================

let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS agentic_apps (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      name        TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'GENERAL',
      description TEXT NOT NULL DEFAULT '',
      objective   TEXT NOT NULL DEFAULT '',
      steps       JSONB NOT NULL DEFAULT '[]'::jsonb,
      icon        TEXT NOT NULL DEFAULT '⚙️',
      status      TEXT NOT NULL DEFAULT 'active',
      run_count   INTEGER NOT NULL DEFAULT 0,
      created_by  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS agentic_app_runs (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    TEXT NOT NULL DEFAULT 'default',
      app_id       UUID NOT NULL,
      input        TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      steps_output JSONB NOT NULL DEFAULT '[]'::jsonb,
      final_output TEXT NOT NULL DEFAULT '',
      error        TEXT,
      created_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_agentic_apps_tenant ON agentic_apps(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agentic_runs_app ON agentic_app_runs(tenant_id, app_id, created_at DESC)`);
  schemaEnsured = true;
}

// ============================================================
// Mappers
// ============================================================

interface AppRow {
  id: string; tenant_id: string; name: string; category: string;
  description: string; objective: string; steps: AppStep[]; icon: string;
  status: string; run_count: number; created_by: string | null;
  created_at: string; updated_at: string;
}
interface RunRow {
  id: string; tenant_id: string; app_id: string; input: string;
  status: string; steps_output: StepOutput[]; final_output: string;
  error: string | null; created_by: string | null;
  created_at: string; completed_at: string | null;
}

function mapApp(r: AppRow): AgenticApp {
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, category: r.category,
    description: r.description, objective: r.objective,
    steps: Array.isArray(r.steps) ? r.steps : [],
    icon: r.icon, status: r.status as AgenticApp["status"],
    runCount: r.run_count, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function mapRun(r: RunRow): AppRun {
  return {
    id: r.id, tenantId: r.tenant_id, appId: r.app_id, input: r.input,
    status: r.status as AppRun["status"],
    stepsOutput: Array.isArray(r.steps_output) ? r.steps_output : [],
    finalOutput: r.final_output, error: r.error,
    createdBy: r.created_by, createdAt: r.created_at, completedAt: r.completed_at,
  };
}

// ============================================================
// CRUD apps
// ============================================================

export interface CreateAppInput {
  name: string;
  category?: string;
  description?: string;
  objective?: string;
  steps: AppStep[];
  icon?: string;
  createdBy?: string | null;
}

async function validateSteps(tenantId: string, steps: AppStep[]): Promise<void> {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("La app necesita al menos 1 paso");
  if (steps.length > MAX_STEPS) throw new Error(`Máximo ${MAX_STEPS} pasos por app`);
  for (const s of steps) {
    if (!s.agentId) throw new Error("Cada paso necesita un agentId");
    const agent = await getAgent(tenantId, s.agentId);
    if (!agent) throw new Error(`Agente ${s.agentId} no existe`);
    if (agent.status !== "active") throw new Error(`El agente "${agent.name}" está archivado`);
  }
}

export async function listApps(tenantId: string): Promise<AgenticApp[]> {
  await ensureSchema();
  const { rows } = await query<AppRow>(
    `SELECT * FROM agentic_apps WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map(mapApp);
}

export async function getApp(tenantId: string, id: string): Promise<AgenticApp | null> {
  await ensureSchema();
  const { rows } = await query<AppRow>(
    `SELECT * FROM agentic_apps WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return rows[0] ? mapApp(rows[0]) : null;
}

export async function createApp(tenantId: string, input: CreateAppInput): Promise<AgenticApp> {
  await ensureSchema();
  if (!input.name?.trim()) throw new Error("name es obligatorio");
  await validateSteps(tenantId, input.steps);
  const { rows } = await query<AppRow>(
    `INSERT INTO agentic_apps (tenant_id, name, category, description, objective, steps, icon, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *`,
    [
      tenantId, input.name.trim(), input.category ?? "GENERAL",
      input.description?.trim() ?? "", input.objective?.trim() ?? "",
      JSON.stringify(input.steps), input.icon ?? "⚙️", input.createdBy ?? null,
    ],
  );
  return mapApp(rows[0]!);
}

export async function deleteApp(tenantId: string, id: string): Promise<boolean> {
  await ensureSchema();
  const res = await query(
    `DELETE FROM agentic_apps WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ============================================================
// Runner — ejecución secuencial en background
// ============================================================

export async function startRun(
  tenantId: string, appId: string, input: string, createdBy: string | null,
): Promise<AppRun> {
  await ensureSchema();
  const app = await getApp(tenantId, appId);
  if (!app) throw new Error("App no encontrada");
  if (app.status !== "active") throw new Error("La app está archivada");
  if (!input.trim()) throw new Error("input es obligatorio");

  const initialSteps: StepOutput[] = app.steps.map((s, i) => ({
    stepIndex: i,
    stepName: s.name || `Paso ${i + 1}`,
    agentId: s.agentId,
    status: "pending",
    output: "",
    durationMs: 0,
  }));

  const { rows } = await query<RunRow>(
    `INSERT INTO agentic_app_runs (tenant_id, app_id, input, steps_output, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
    [tenantId, appId, input.trim(), JSON.stringify(initialSteps), createdBy],
  );
  const run = mapRun(rows[0]!);

  // Ejecutar en background — el frontend hace polling al run
  setImmediate(() => {
    executeRun(tenantId, run.id, app, input.trim(), createdBy ?? "system").catch((err) => {
      logger.error({ err, runId: run.id }, "agentic run crashed");
    });
  });

  return run;
}

async function updateRunSteps(runId: string, steps: StepOutput[]): Promise<void> {
  await query(
    `UPDATE agentic_app_runs SET steps_output = $2::jsonb WHERE id = $1`,
    [runId, JSON.stringify(steps)],
  );
}

async function executeRun(
  tenantId: string, runId: string, app: AgenticApp, input: string, user: string,
): Promise<void> {
  const steps: StepOutput[] = app.steps.map((s, i) => ({
    stepIndex: i,
    stepName: s.name || `Paso ${i + 1}`,
    agentId: s.agentId,
    status: "pending",
    output: "",
    durationMs: 0,
  }));

  let currentInput = input;
  try {
    for (let i = 0; i < app.steps.length; i++) {
      const stepDef = app.steps[i]!;
      steps[i]!.status = "running";
      await updateRunSteps(runId, steps);

      const started = Date.now();
      const message = stepDef.instruction?.trim()
        ? `${stepDef.instruction.trim()}\n\nINPUT DEL PASO ANTERIOR:\n${currentInput}`
        : currentInput;

      const { result } = await chatWithCustomAgent(tenantId, stepDef.agentId, {
        message,
        user: `app:${app.name}:${user}`,
      });

      steps[i]!.status = "done";
      steps[i]!.output = result.text;
      steps[i]!.durationMs = Date.now() - started;
      await updateRunSteps(runId, steps);

      currentInput = result.text;
    }

    await query(
      `UPDATE agentic_app_runs
          SET status = 'done', final_output = $2, completed_at = now()
        WHERE id = $1`,
      [runId, currentInput],
    );
    await query(
      `UPDATE agentic_apps SET run_count = run_count + 1 WHERE id = $1`,
      [app.id],
    );
    logger.info({ runId, app: app.name, steps: app.steps.length }, "agentic run done");
  } catch (err) {
    const failedIdx = steps.findIndex((s) => s.status === "running");
    if (failedIdx >= 0) steps[failedIdx]!.status = "failed";
    await updateRunSteps(runId, steps).catch(() => null);
    await query(
      `UPDATE agentic_app_runs
          SET status = 'failed', error = $2, completed_at = now()
        WHERE id = $1`,
      [runId, (err as Error).message],
    ).catch(() => null);
    logger.error({ err, runId }, "agentic run failed");
  }
}

export async function getRun(tenantId: string, runId: string): Promise<AppRun | null> {
  await ensureSchema();
  const { rows } = await query<RunRow>(
    `SELECT * FROM agentic_app_runs WHERE id = $1 AND tenant_id = $2`,
    [runId, tenantId],
  );
  return rows[0] ? mapRun(rows[0]) : null;
}

export async function listRuns(tenantId: string, appId: string, limit = 20): Promise<AppRun[]> {
  await ensureSchema();
  const { rows } = await query<RunRow>(
    `SELECT * FROM agentic_app_runs WHERE tenant_id = $1 AND app_id = $2
     ORDER BY created_at DESC LIMIT $3`,
    [tenantId, appId, limit],
  );
  return rows.map(mapRun);
}
