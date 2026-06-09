import { Pool, type PoolClient } from "pg";
import { logger } from "../utils/logger";

// =============================================================================
// db.ts — Postgres pool + helpers (v1.1.2 — audit fixes C10 + helpers)
// =============================================================================
// FIX C10 (audit v1.1.0):
//   - Pool max ampliado de 10 a 25 (admin-usage hace 9+ queries Promise.all)
//   - statement_timeout 15s — query lenta no cuelga worker indefinidamente
//   - query_timeout 20s — wrapper de cliente
//   - connectionTimeoutMillis 5s — falla rápido si DB inaccesible
//   - withTx<T>(fn) — helper para transacciones BEGIN/COMMIT/ROLLBACK
// =============================================================================

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  logger.warn("DATABASE_URL no esta definida; las queries fallaran hasta configurarla");
}

const POOL_MAX = Number(process.env.PG_POOL_MAX ?? 25);
const POOL_MIN = Number(process.env.PG_POOL_MIN ?? 2);
const IDLE_TIMEOUT_MS = Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000);
const CONNECTION_TIMEOUT_MS = Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5_000);
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000);
const QUERY_TIMEOUT_MS = Number(process.env.PG_QUERY_TIMEOUT_MS ?? 20_000);

export const pool = new Pool({
  connectionString,
  max: POOL_MAX,
  min: POOL_MIN,
  idleTimeoutMillis: IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  query_timeout: QUERY_TIMEOUT_MS,
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

/**
 * Ejecuta una función dentro de una transacción.
 * BEGIN → fn(client) → COMMIT, o ROLLBACK si tira.
 * Usar para multi-step que debe ser atómico (ej: upsert + history insert).
 *
 * Ejemplo:
 *   const result = await withTx(async (client) => {
 *     await client.query("UPDATE tickets SET status=$1 WHERE id=$2", [...]);
 *     await client.query("INSERT INTO ticket_history (...) VALUES (...)", [...]);
 *     return ticketId;
 *   });
 */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rbErr) {
      logger.error({ err: rbErr }, "ROLLBACK también falló");
    }
    throw err;
  } finally {
    client.release();
  }
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

/** Stats del pool para /metrics y /admin/pool. */
export function getPoolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: POOL_MAX,
  };
}
