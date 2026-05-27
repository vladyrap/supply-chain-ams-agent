import { Pool } from "pg";
import { logger } from "./logger";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL no definida en el worker");
}

export const pool = new Pool({ connectionString, max: 4 });

pool.on("error", (err) => logger.error({ err }, "pool error"));

export async function query<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const res = await pool.query(text, params as never[]);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}
