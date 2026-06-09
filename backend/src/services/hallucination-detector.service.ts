// Hallucination detection (multi-tenant).
//
// MT-3: la whitelist y el reporte son por tenant. Cada tenant tiene su
// propio corpus de transacciones SAP "permitidas" y su propio log de
// alucinaciones para análisis.
//
// Construye una whitelist de transacciones SAP que aparecen en el
// corpus del tenant (kb_training_items + kb_training_qa).
// Cuando el agente responde, extrae las transacciones SAP mencionadas
// y compara con la whitelist del tenant. Si menciona transacciones
// nuevas que no están en el corpus de ese tenant, las flag.
//
// Patrones detectados:
//   - Transacciones SAP: 2-6 chars alphanumeric mayúsculas (ME21N, VA01, /SCWM/PRDO, etc.)
//   - Tablas SAP: 3-10 chars mayúsculas (KNA1, EKPO, etc.)
//   - Códigos custom Z* o Y* → siempre suspicious
//
// Tabla agent_hallucinations para tracking + reporte (scoped).

import { query } from "../database/db";
import { logger } from "../utils/logger";

let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS agent_hallucinations (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       TEXT NOT NULL DEFAULT 'default',
        response_id     TEXT,
        user_query      TEXT,
        suspicious      TEXT[] NOT NULL DEFAULT '{}'::text[],
        custom_z_y      TEXT[] NOT NULL DEFAULT '{}'::text[],
        total_tx_found  INTEGER NOT NULL DEFAULT 0,
        risk_score      INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Migración idempotente: tenant_id si la tabla ya existía.
    await query(`ALTER TABLE agent_hallucinations ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';`);
    await query(`CREATE INDEX IF NOT EXISTS idx_halluc_created ON agent_hallucinations(created_at DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_halluc_tenant  ON agent_hallucinations(tenant_id, created_at DESC)`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure agent_hallucinations schema failed");
  }
}

// Regex para extraer transacciones SAP típicas
const TX_REGEX = /\b\/?[A-Z][A-Z0-9_]{1,15}(?:\/[A-Z0-9_]+)?\b/g;

// Whitelist de comunes que no son transacciones (pero hacen match)
const COMMON_NOT_TX = new Set([
  "AMS", "SAP", "ABAP", "DTE", "SII", "XML", "JSON", "HTTP", "HTTPS",
  "URL", "API", "REST", "BTP", "GUI", "OS", "PC", "TI", "IT",
  "FI", "MM", "SD", "PP", "CO", "QM", "EWM", "WM", "TM",
  "OC", "OV", "GR", "PR", "PO", "RFQ", "RA", "EM", "WT", "HU",
  "USA", "ESP", "MEX", "ARG", "CHI", "BRA", "COL", "PE",
  "USD", "EUR", "MXN", "CLP", "ARS", "BRL",
  "NO", "SI", "YES", "OK", "KO",
]);

// MT-3: cache POR TENANT.
const cachedWhitelistByTenant = new Map<string, { set: Set<string>; at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function extractTransactions(text: string): string[] {
  const seen = new Set<string>();
  const matches = text.match(TX_REGEX);
  if (!matches) return [];
  for (const m of matches) {
    const tx = m.toUpperCase();
    if (tx.length < 3) continue;
    if (COMMON_NOT_TX.has(tx.replace(/^\//, ""))) continue;
    if (!/\d/.test(tx) && !tx.startsWith("/")) continue;
    seen.add(tx);
  }
  return Array.from(seen);
}

export async function getWhitelistFromCorpus(tenantId: string): Promise<Set<string>> {
  const cached = cachedWhitelistByTenant.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.set;
  const w = new Set<string>();
  try {
    const { rows } = await query<{ text: string }>(
      `SELECT (title || ' ' || summary || ' ' || content || ' ' || array_to_string(tags, ' ')) AS text
         FROM kb_training_items
        WHERE tenant_id = $1
          AND status IN ('PUBLISHED','VALIDATED','PENDING_REVIEW','DRAFT')`,
      [tenantId]
    );
    for (const r of rows) {
      for (const tx of extractTransactions(r.text)) w.add(tx);
    }
  } catch (err) {
    logger.debug({ err, tenantId }, "whitelist items fail");
  }
  try {
    const { rows } = await query<{ text: string }>(
      `SELECT (question || ' ' || expected_answer) AS text
         FROM kb_training_qa
        WHERE tenant_id = $1 AND approved = true`,
      [tenantId]
    );
    for (const r of rows) {
      for (const tx of extractTransactions(r.text)) w.add(tx);
    }
  } catch (err) {
    logger.debug({ err, tenantId }, "whitelist qa fail");
  }
  cachedWhitelistByTenant.set(tenantId, { set: w, at: Date.now() });
  logger.info({ size: w.size, tenantId }, "hallucination whitelist refreshed");
  return w;
}

export function invalidateWhitelist(tenantId?: string): void {
  if (tenantId) cachedWhitelistByTenant.delete(tenantId);
  else cachedWhitelistByTenant.clear();
}

export interface HallucinationCheck {
  responseId: string | null;
  txFound: string[];
  inWhitelist: string[];
  suspicious: string[];       // mencionadas pero no en whitelist
  customZY: string[];         // Z* / Y* siempre suspect en código custom
  riskScore: number;          // 0-100
}

/**
 * Analiza la respuesta del agente. Devuelve métricas + persiste si hay riesgo.
 * Scoped al tenant.
 */
export async function checkHallucinations(
  tenantId: string,
  input: { responseId?: string; userQuery?: string; responseText: string },
): Promise<HallucinationCheck> {
  const whitelist = await getWhitelistFromCorpus(tenantId);
  const tx = extractTransactions(input.responseText);
  const inWhitelist: string[] = [];
  const suspicious: string[] = [];
  const customZY: string[] = [];
  for (const t of tx) {
    if (whitelist.has(t)) inWhitelist.push(t);
    else if (/^[ZY][A-Z0-9_]/.test(t.replace(/^\//, ""))) {
      customZY.push(t);
      suspicious.push(t);
    } else {
      suspicious.push(t);
    }
  }
  const total = tx.length;
  const baseRisk = total > 0 ? Math.round((suspicious.length / total) * 100) : 0;
  const bonus = Math.min(20, customZY.length * 10);
  const riskScore = Math.min(100, baseRisk + bonus);

  if (suspicious.length > 0 || customZY.length > 0) {
    await ensureSchema();
    try {
      await query(
        `INSERT INTO agent_hallucinations
           (tenant_id, response_id, user_query, suspicious, custom_z_y, total_tx_found, risk_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          input.responseId ?? null,
          input.userQuery?.slice(0, 2000) ?? null,
          suspicious,
          customZY,
          total,
          riskScore,
        ]
      );
    } catch (err) {
      logger.debug({ err, tenantId }, "hallucination persist fail");
    }
  }

  return {
    responseId: input.responseId ?? null,
    txFound: tx,
    inWhitelist,
    suspicious,
    customZY,
    riskScore,
  };
}

// =====================================================
// Reporte agregado (scoped al tenant)
// =====================================================
export interface HallucinationReport {
  totalLogged: number;
  last7d: number;
  avgRisk7d: number;
  topSuspicious: { tx: string; count: number }[];
  recentSamples: {
    id: string; created_at: string;
    suspicious: string[]; custom_z_y: string[];
    risk_score: number; user_query: string | null;
  }[];
}

export async function getHallucinationReport(tenantId: string): Promise<HallucinationReport> {
  await ensureSchema();
  const report: HallucinationReport = {
    totalLogged: 0, last7d: 0, avgRisk7d: 0,
    topSuspicious: [], recentSamples: [],
  };
  try {
    const { rows } = await query<{ total: string; last7d: string; avg: string }>(
      `SELECT
         count(*)::text AS total,
         count(*) FILTER (WHERE created_at > now() - interval '7 days')::text AS last7d,
         COALESCE(round(avg(risk_score) FILTER (WHERE created_at > now() - interval '7 days'))::text, '0') AS avg
       FROM agent_hallucinations
      WHERE tenant_id = $1`,
      [tenantId]
    );
    report.totalLogged = Number(rows[0]?.total ?? 0);
    report.last7d = Number(rows[0]?.last7d ?? 0);
    report.avgRisk7d = Number(rows[0]?.avg ?? 0);
  } catch { /* */ }

  try {
    const { rows } = await query<{ tx: string; c: string }>(
      `SELECT unnest(suspicious) AS tx, count(*)::text AS c
         FROM agent_hallucinations
        WHERE tenant_id = $1
          AND created_at > now() - interval '30 days'
        GROUP BY tx
        ORDER BY c::int DESC
        LIMIT 10`,
      [tenantId]
    );
    report.topSuspicious = rows.map((r) => ({ tx: r.tx, count: Number(r.c) }));
  } catch { /* */ }

  try {
    const { rows } = await query<{ id: string; created_at: string; suspicious: string[]; custom_z_y: string[]; risk_score: number; user_query: string | null }>(
      `SELECT id, created_at, suspicious, custom_z_y, risk_score, user_query
         FROM agent_hallucinations
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [tenantId]
    );
    report.recentSamples = rows;
  } catch { /* */ }

  return report;
}
