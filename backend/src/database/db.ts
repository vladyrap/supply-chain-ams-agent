import { Pool } from "pg";
import { logger } from "../utils/logger";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  logger.warn("DATABASE_URL no esta definida; las queries fallaran hasta configurarla");
}

export const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  logger.error({ err }, "Error inesperado en pool Postgres");
});

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const start = Date.now();
  const res = await pool.query(text, params as never[]);
  const duration = Date.now() - start;
  logger.debug({ sql: text, durationMs: duration, rows: res.rowCount }, "db.query");
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

export async function ping(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err) {
    logger.error({ err }, "Postgres ping failed");
    return false;
  }
}
