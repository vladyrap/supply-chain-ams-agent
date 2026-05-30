import "dotenv/config";
import { buildServer } from "./server";
import { logger } from "./utils/logger";
import { bootstrapAdminIfNeeded } from "./services/auth.service";
import { ensureVoiceSchema } from "./services/call-log.service";
import { seedTrainingIfEmpty } from "./services/training.seed";
import { bootstrapSelfTrainingCron } from "./services/self-training-cron.service";

const PORT = Number(process.env.BACKEND_PORT ?? 8000);
const HOST = "0.0.0.0";

async function main() {
  const app = buildServer();

  // Crear admin de bootstrap si está configurado en env vars y no hay usuarios.
  await bootstrapAdminIfNeeded().catch((err) => {
    logger.warn({ err }, "bootstrap admin falló");
  });

  // Asegurar schema del canal telefónico (idempotente, best-effort).
  await ensureVoiceSchema().catch((err) => {
    logger.warn({ err }, "ensureVoiceSchema falló (continuamos)");
  });

  // Seed del Centro de Entrenamiento si tablas vacías (idempotente)
  await seedTrainingIfEmpty().catch((err) => {
    logger.warn({ err }, "seedTrainingIfEmpty falló (continuamos)");
  });

  // Bootstrap del worker + repeat job del self-training cron
  await bootstrapSelfTrainingCron().catch((err) => {
    logger.warn({ err }, "bootstrapSelfTrainingCron falló (continuamos)");
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    logger.info({ port: PORT }, "ams-backend listening");
  } catch (err) {
    logger.error({ err }, "Fallo al iniciar el servidor");
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error en shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
