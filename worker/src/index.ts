import "dotenv/config";
import { Worker, type Job, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import cron from "node-cron";
import { logger } from "./logger";
import { processIngest, type IngestJobData } from "./jobs/ingest";
import { processMeeting, type MeetingJobData } from "./jobs/meeting";
import {
  checkSlaWarnings, detectAnomalies, reopenStaleConversations, generateDailyReport,
} from "./jobs/autonomous";

const REDIS_URL = process.env.REDIS_URL || "redis://supply-chain-ams-redis:6379";

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => logger.error({ err }, "redis error"));
connection.on("connect", () => logger.info({ REDIS_URL }, "redis connected"));

// BullMQ ancla su propia copia de ioredis; el typecheck cruzado falla aunque a runtime
// el cliente es idéntico. Cast a ConnectionOptions solo para satisfacer al Worker.
const bullConnection = connection as unknown as ConnectionOptions;

const ingestWorker = new Worker<IngestJobData>(
  "knowledge-ingest",
  async (job: Job<IngestJobData>) => {
    logger.info({ jobId: job.id, documentId: job.data.documentId }, "ingest start");
    await processIngest(job.data);
    return { ok: true };
  },
  { connection: bullConnection, concurrency: 1, autorun: true }
);

const meetingWorker = new Worker<MeetingJobData>(
  "meeting-process",
  async (job: Job<MeetingJobData>) => {
    logger.info({ jobId: job.id, meetingId: job.data.meetingId }, "meeting start");
    await processMeeting(job.data);
    return { ok: true };
  },
  { connection: bullConnection, concurrency: 1, autorun: true }
);

for (const [name, w] of [["ingest", ingestWorker], ["meeting", meetingWorker]] as const) {
  w.on("completed", (job) => logger.info({ jobId: job.id, queue: name }, "job completed"));
  w.on("failed", (job, err) => logger.error({ jobId: job?.id, queue: name, err }, "job failed"));
}

// ============================================================
// Agente autónomo: cron jobs
// ============================================================
// Schedules (UTC del contenedor):
//   - SLA warnings: cada 5 minutos
//   - Anomaly detection: cada hora en el minuto 5
//   - Stale conversations: cada hora en el minuto 15
//   - Daily report: todos los días a las 08:00
//
// Cualquier job falla → log y sigue, NO tira el worker.
// ============================================================
cron.schedule("*/5 * * * *", async () => {
  const r = await checkSlaWarnings();
  if (r.emitted > 0) logger.info({ ...r }, "cron: sla warnings");
});

cron.schedule("5 * * * *", async () => {
  const r = await detectAnomalies();
  if (r.anomalies > 0) logger.info({ ...r }, "cron: anomalies");
});

cron.schedule("15 * * * *", async () => {
  const r = await reopenStaleConversations();
  if (r.stale > 0) logger.info({ ...r }, "cron: stale convs");
});

cron.schedule("0 8 * * *", async () => {
  const r = await generateDailyReport();
  logger.info({ ...r }, "cron: daily report");
});

logger.info("supply-chain-ams-worker iniciado · queues=[knowledge-ingest, meeting-process] · cron=[sla/anomaly/stale/report]");

const shutdown = async (signal: string) => {
  logger.info({ signal }, "worker shutting down");
  try {
    await ingestWorker.close();
    await meetingWorker.close();
    await connection.quit();
  } catch (err) {
    logger.error({ err }, "shutdown error");
  }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
