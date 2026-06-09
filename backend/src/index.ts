import "dotenv/config";
import { buildServer } from "./server";
import { logger } from "./utils/logger";
import { query } from "./database/db";
import { bootstrapAdminIfNeeded } from "./services/auth.service";
import { ensureVoiceSchema } from "./services/call-log.service";
import { seedTrainingIfEmpty } from "./services/training.seed";
import { bootstrapSelfTrainingCron } from "./services/self-training-cron.service";

const PORT = Number(process.env.BACKEND_PORT ?? 8000);
const HOST = "0.0.0.0";

async function main() {
  const app = buildServer();

  // Crear admin de bootstrap si está configurado en env vars y no hay usuarios.
  // TODO MT-6: scope per-tenant cron — actualmente usa 'default' implícito.
  await bootstrapAdminIfNeeded("default").catch((err) => {
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

  // Fail-fast: verificar que la tabla tenants existe y tiene el 'default' seedeado.
  // En PROD, si las migrations 005+006+007 no fueron aplicadas, los INSERTs
  // posteriores fallarían con FK violation en runtime. Mejor explotar acá
  // con un mensaje claro que dejar el server "vivo" pero roto.
  if (process.env.NODE_ENV === "production") {
    try {
      const { rows } = await query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM tenants WHERE id='default') AS exists`
      );
      if (!rows[0]?.exists) {
        console.error("FATAL: tabla 'tenants' no existe o 'default' no seedeada.");
        console.error("Aplicar migration: database/migrations/005-multi-tenant-foundation.sql");
        process.exit(1);
      }
      logger.info("✓ Tenants foundation OK");
    } catch (err) {
      console.error("FATAL: no se puede consultar tabla 'tenants':", err);
      console.error("Aplicar migrations 005+006+007 antes de bootear en prod.");
      process.exit(1);
    }
  }

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
