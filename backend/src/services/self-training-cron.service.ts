// Cron BullMQ del self-training cycle (multi-tenant).
//
// MT-3: la config + el historial son globales (los gerencia super_admin),
// pero el worker itera todos los tenants activos/trial y corre
// runSelfTrainingCycle(tenantId) por cada uno. Cada run queda registrado
// en kb_self_training_runs con su tenant_id.
//
// Settings vivas en kb_self_training_config (global):
//   - enabled: bool
//   - intervalHours: 1-168
//   - runEval: bool (false = más rápido + menos quota Gemini)

import { Queue, Worker } from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { runSelfTrainingCycle, type SelfTrainingReport } from "./self-training.service";

const REDIS_URL = process.env.REDIS_URL || "redis://supply-chain-ams-redis:6379";
const JOB_NAME = "self-training-cycle";
const REPEAT_JOB_ID = "self-training-recurring";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) as any;
connection.on?.("error", (err: unknown) => logger.error({ err }, "self-training queue redis error"));

export const selfTrainingQueue = new Queue(JOB_NAME, { connection });

// ===================== schema =====================
let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS kb_self_training_config (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        enabled         BOOLEAN NOT NULL DEFAULT false,
        interval_hours  INTEGER NOT NULL DEFAULT 6,
        run_eval        BOOLEAN NOT NULL DEFAULT true,
        last_scheduled  TIMESTAMPTZ,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS kb_self_training_runs (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        TEXT,
        triggered_by     TEXT NOT NULL DEFAULT 'cron',
        stages_summary   JSONB NOT NULL DEFAULT '[]'::jsonb,
        before_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
        after_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
        total_ms         INTEGER NOT NULL DEFAULT 0,
        started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at      TIMESTAMPTZ
      );
    `);
    // Migración idempotente: agregar tenant_id si la tabla ya existía.
    await query(`ALTER TABLE kb_self_training_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT;`);
    await query(`CREATE INDEX IF NOT EXISTS idx_kb_self_runs_started ON kb_self_training_runs(started_at DESC);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_kb_self_runs_tenant  ON kb_self_training_runs(tenant_id, started_at DESC);`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure self-training schema failed");
  }
}

// ===================== config =====================
export interface SelfTrainingConfig {
  id: string;
  enabled: boolean;
  interval_hours: number;
  run_eval: boolean;
  last_scheduled: string | null;
  updated_at: string;
}

export async function getSelfTrainingConfig(): Promise<SelfTrainingConfig> {
  await ensureSchema();
  const { rows } = await query<SelfTrainingConfig>(
    `SELECT * FROM kb_self_training_config ORDER BY updated_at DESC LIMIT 1`
  );
  if (rows[0]) return rows[0];
  const { rows: created } = await query<SelfTrainingConfig>(
    `INSERT INTO kb_self_training_config DEFAULT VALUES RETURNING *`
  );
  return created[0]!;
}

export interface UpdateConfigInput {
  enabled?: boolean;
  intervalHours?: number;
  runEval?: boolean;
}

export async function updateSelfTrainingConfig(patch: UpdateConfigInput): Promise<SelfTrainingConfig> {
  const current = await getSelfTrainingConfig();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.enabled !== undefined)        { params.push(patch.enabled);                                  sets.push(`enabled = $${params.length}`); }
  if (patch.intervalHours !== undefined)  { params.push(Math.max(1, Math.min(168, patch.intervalHours))); sets.push(`interval_hours = $${params.length}`); }
  if (patch.runEval !== undefined)        { params.push(patch.runEval);                                  sets.push(`run_eval = $${params.length}`); }
  sets.push(`updated_at = now()`);
  params.push(current.id);
  const { rows } = await query<SelfTrainingConfig>(
    `UPDATE kb_self_training_config SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params
  );
  const next = rows[0]!;
  // Reflejar en la queue
  await applyScheduleFromConfig(next);
  return next;
}

// ===================== schedule sync =====================
async function applyScheduleFromConfig(cfg: SelfTrainingConfig): Promise<void> {
  try {
    // Borrar el repeat existente (idempotente)
    const repeats = await selfTrainingQueue.getRepeatableJobs();
    for (const r of repeats) {
      if (r.id === REPEAT_JOB_ID || r.name === JOB_NAME) {
        await selfTrainingQueue.removeRepeatableByKey(r.key);
      }
    }
    if (cfg.enabled) {
      const every = Math.max(60_000, cfg.interval_hours * 60 * 60 * 1000);
      await selfTrainingQueue.add(
        JOB_NAME,
        { triggeredBy: "cron", runEval: cfg.run_eval },
        { repeat: { every }, jobId: REPEAT_JOB_ID, removeOnComplete: 20, removeOnFail: 50 }
      );
      await query(`UPDATE kb_self_training_config SET last_scheduled = now() WHERE id = $1`, [cfg.id]);
      logger.info({ intervalHours: cfg.interval_hours, runEval: cfg.run_eval }, "self-training cron scheduled");
    } else {
      logger.info("self-training cron disabled");
    }
  } catch (err) {
    logger.warn({ err }, "applyScheduleFromConfig failed");
  }
}

// ===================== worker =====================
// MT-3: el worker itera TODOS los tenants activos/trial y corre el ciclo
// por cada uno. Cada per-tenant run queda registrado individualmente.
async function listActiveTenantIds(): Promise<string[]> {
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM tenants WHERE status IN ('active','trial') ORDER BY created_at ASC`,
    );
    return rows.map((r) => r.id);
  } catch (err) {
    // Si la tabla tenants no existe (single-tenant legacy), correr con default.
    logger.debug({ err }, "listActiveTenantIds: fallback a default");
    return [process.env.DEFAULT_TENANT_ID ?? "default"];
  }
}

async function runCycleForTenant(
  tenantId: string,
  triggeredBy: string,
  runEval: boolean,
): Promise<{ runId: string; report: SelfTrainingReport | null }> {
  await ensureSchema();
  const { rows: prep } = await query<{ id: string }>(
    `INSERT INTO kb_self_training_runs (tenant_id, triggered_by) VALUES ($1, $2) RETURNING id`,
    [tenantId, triggeredBy]
  );
  const runId = prep[0]!.id;
  let report: SelfTrainingReport | null = null;
  try {
    report = await runSelfTrainingCycle(tenantId, { runEval });
  } catch (err) {
    logger.error({ err, tenantId }, "self-training worker exec fail (per-tenant)");
  }
  if (report) {
    await query(
      `UPDATE kb_self_training_runs
          SET stages_summary  = $1,
              before_snapshot = $2,
              after_snapshot  = $3,
              total_ms        = $4,
              finished_at     = now()
        WHERE id = $5`,
      [
        JSON.stringify(report.stages),
        JSON.stringify(report.before),
        JSON.stringify(report.after),
        report.totalMs,
        runId,
      ]
    );
  }
  return { runId, report };
}

let workerStarted = false;
export function startSelfTrainingWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const worker = new Worker(
    JOB_NAME,
    async (job) => {
      const data = (job.data as { triggeredBy?: string; runEval?: boolean; tenantId?: string }) ?? {};
      await ensureSchema();
      const runEval = data.runEval !== false;
      const triggeredBy = data.triggeredBy ?? "cron";

      // Caso 1: triggered_by manual con tenantId explícito → solo ese tenant.
      if (data.tenantId) {
        await runCycleForTenant(data.tenantId, triggeredBy, runEval);
        return;
      }

      // Caso 2: cron → iterar todos los tenants activos/trial.
      const tenantIds = await listActiveTenantIds();
      logger.info({ tenants: tenantIds.length }, "self-training cron: iterando tenants");
      for (const tenantId of tenantIds) {
        try {
          await runCycleForTenant(tenantId, triggeredBy, runEval);
        } catch (err) {
          logger.error({ err, tenantId }, "self-training cron: tenant fail (continuo)");
        }
      }
    },
    { connection }
  );
  worker.on("error", (err) => logger.error({ err }, "self-training worker error"));
  worker.on("completed", (job) => logger.info({ id: job.id }, "self-training cron job completed"));
  logger.info("self-training worker started");
}

/** Llamar al arranque del backend para sincronizar el schedule con la config persistida. */
export async function bootstrapSelfTrainingCron(): Promise<void> {
  await ensureSchema();
  try {
    const cfg = await getSelfTrainingConfig();
    startSelfTrainingWorker();
    await applyScheduleFromConfig(cfg);
  } catch (err) {
    logger.warn({ err }, "bootstrap self-training cron failed");
  }
}

// ===================== history =====================
export interface SelfTrainingRunHistory {
  id: string;
  tenant_id: string | null;
  triggered_by: string;
  before_snapshot: SelfTrainingReport["before"] | Record<string, never>;
  after_snapshot: (SelfTrainingReport["after"]) | Record<string, never>;
  total_ms: number;
  started_at: string;
  finished_at: string | null;
}

/**
 * MT-3: lista historial filtrado por tenant. Para super_admin que quiere
 * ver todos los runs (cross-tenant), pasar tenantId="*".
 */
export async function listSelfTrainingHistory(tenantId: string, limit = 30): Promise<SelfTrainingRunHistory[]> {
  await ensureSchema();
  const safeLimit = Math.max(1, Math.min(200, limit));
  if (tenantId === "*") {
    const { rows } = await query<SelfTrainingRunHistory>(
      `SELECT id, tenant_id, triggered_by, before_snapshot, after_snapshot, total_ms, started_at, finished_at
         FROM kb_self_training_runs
        ORDER BY started_at DESC
        LIMIT $1`,
      [safeLimit]
    );
    return rows;
  }
  const { rows } = await query<SelfTrainingRunHistory>(
    `SELECT id, tenant_id, triggered_by, before_snapshot, after_snapshot, total_ms, started_at, finished_at
       FROM kb_self_training_runs
      WHERE tenant_id = $1 OR tenant_id IS NULL
      ORDER BY started_at DESC
      LIMIT $2`,
    [tenantId, safeLimit]
  );
  return rows;
}
