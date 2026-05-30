// Cron BullMQ del self-training cycle.
//
// Permite agendar runSelfTrainingCycle cada N horas como repeat job.
// Settings activas en kb_training_settings (campo virtual via kb_self_training_config):
//   - enabled: bool
//   - intervalHours: 1-168
//   - runEval: bool (false = más rápido + menos quota Gemini)
//
// Historial completo en tabla kb_self_training_runs para que la UI
// pueda mostrar el "último run automático" y la curva de mejora.

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
        triggered_by     TEXT NOT NULL DEFAULT 'cron',
        stages_summary   JSONB NOT NULL DEFAULT '[]'::jsonb,
        before_snapshot  JSONB NOT NULL DEFAULT '{}'::jsonb,
        after_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,
        total_ms         INTEGER NOT NULL DEFAULT 0,
        started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at      TIMESTAMPTZ
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_kb_self_runs_started ON kb_self_training_runs(started_at DESC);`);
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
let workerStarted = false;
export function startSelfTrainingWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const worker = new Worker(
    JOB_NAME,
    async (job) => {
      const data = (job.data as { triggeredBy?: string; runEval?: boolean }) ?? {};
      await ensureSchema();
      const { rows: prep } = await query<{ id: string }>(
        `INSERT INTO kb_self_training_runs (triggered_by) VALUES ($1) RETURNING id`,
        [data.triggeredBy ?? "cron"]
      );
      const runId = prep[0]!.id;
      let report: SelfTrainingReport | null = null;
      try {
        report = await runSelfTrainingCycle({ runEval: data.runEval !== false });
      } catch (err) {
        logger.error({ err }, "self-training worker exec fail");
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
  triggered_by: string;
  before_snapshot: SelfTrainingReport["before"] | Record<string, never>;
  after_snapshot: (SelfTrainingReport["after"]) | Record<string, never>;
  total_ms: number;
  started_at: string;
  finished_at: string | null;
}

export async function listSelfTrainingHistory(limit = 30): Promise<SelfTrainingRunHistory[]> {
  await ensureSchema();
  const { rows } = await query<SelfTrainingRunHistory>(
    `SELECT id, triggered_by, before_snapshot, after_snapshot, total_ms, started_at, finished_at
       FROM kb_self_training_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(200, limit))]
  );
  return rows;
}
