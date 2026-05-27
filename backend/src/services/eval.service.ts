// Eval framework — compara configs del agente (modelo, temperatura, etc.)
// contra un set de preguntas. Ejecuta en background, persiste resultados
// y calcula métricas agregadas (latencia, % bloques completos, confianza).
//
// Flujo:
//   1. createEvalRun(name, configs[], questions[])
//        Crea fila en eval_runs + (configs × questions) filas en eval_results
//        con status 'pending'. Devuelve runId.
//   2. executeEvalRun(runId)  [fire-and-forget]
//        Itera por cada fila pending, llama a Gemini con la config dada,
//        guarda response, confidence, latency_ms, has_12_blocks.
//        Maneja 429 con backoff: si vuelve a fallar marca quota_error y sigue.
//   3. getEvalRun(runId)  [polling desde UI]
//        Devuelve el run con summary y filas. La UI grafica scorecard.
import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";

async function queryRow<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
  const { rows } = await query<T>(sql, params);
  return rows[0] ?? null;
}
import { logger } from "../utils/logger";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { detectConfidence } from "./claude.service";
import { extractUsage, recordUsageFireAndForget } from "./usage.service";
import type { ConfidenceLevel } from "../types/ams.types";

export interface EvalConfig {
  label: string;             // ej. "flash-lite-base"
  model: string;             // ej. "gemini-2.5-flash-lite"
  temperature?: number;      // default 0.4
}

export interface EvalQuestion {
  text: string;
  expected_module?: string;  // opcional, para medir match
}

export interface EvalRunRow {
  id: string;
  name: string;
  config_label: string;
  config: EvalConfig;
  status: "pending" | "running" | "done" | "failed";
  total: number;
  completed: number;
  summary: EvalSummary | null;
  created_at: string;
  updated_at: string;
}

export interface EvalResultRow {
  id: string;
  run_id: string;
  config_label: string;
  question: string;
  expected_module: string | null;
  response: string | null;
  confidence: ConfidenceLevel | null;
  latency_ms: number | null;
  has_12_blocks: boolean | null;
  status: "pending" | "ok" | "error" | "quota_error";
  error: string | null;
  created_at: string;
}

export interface EvalSummary {
  total: number;
  ok: number;
  errors: number;
  quotaErrors: number;
  avgLatencyMs: number;
  pct12Blocks: number;
  confidenceDist: Record<ConfidenceLevel, number>;
}

const TWELVE_BLOCK_MARKERS = [
  "resumen ejecutivo", "diagnóstico", "causa raíz", "solución",
  "pasos", "validación", "rollback", "riesgos",
  "comunicación", "documentación", "seguimiento", "nivel de confianza",
];

function has12Blocks(text: string): boolean {
  const t = text.toLowerCase();
  let hits = 0;
  for (const m of TWELVE_BLOCK_MARKERS) {
    if (t.includes(m)) hits++;
  }
  return hits >= 10; // tolerancia: 10 de 12 marcadores
}

let ai: GoogleGenAI | null = null;
function getAi(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");
  if (!ai) ai = new GoogleGenAI({ apiKey });
  return ai;
}

let cachedPrompt: string | null = null;
async function loadPrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;
  const p = path.resolve(process.cwd(), "prompts", "ams-system-prompt.md");
  cachedPrompt = await readFile(p, "utf-8");
  return cachedPrompt;
}

function isQuotaError(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = String((err as any)?.message ?? err);
  return msg.includes("RESOURCE_EXHAUSTED") ||
         msg.includes("exceeded your current quota") ||
         msg.includes(" 429") ||
         msg.includes("Too Many Requests");
}

// ============================================================
// API pública
// ============================================================

export async function createEvalRun(
  name: string,
  configs: EvalConfig[],
  questions: EvalQuestion[]
): Promise<{ runIds: string[] }> {
  if (!name.trim()) throw new Error("name vacío");
  if (configs.length === 0) throw new Error("configs vacío");
  if (questions.length === 0) throw new Error("questions vacío");

  const runIds: string[] = [];
  for (const cfg of configs) {
    const run = await queryRow<{ id: string }>(
      `INSERT INTO eval_runs (name, config_label, config, status, total, completed)
       VALUES ($1, $2, $3::jsonb, 'pending', $4, 0) RETURNING id`,
      [name, cfg.label, JSON.stringify(cfg), questions.length]
    );
    if (!run) throw new Error("no se pudo crear run");
    runIds.push(run.id);

    // Bulk insert de eval_results pendientes
    for (const q of questions) {
      await query(
        `INSERT INTO eval_results (run_id, config_label, question, expected_module, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [run.id, cfg.label, q.text, q.expected_module ?? null]
      );
    }
  }

  return { runIds };
}

export async function listEvalRuns(): Promise<EvalRunRow[]> {
  const { rows } = await query<EvalRunRow>(
    `SELECT id, name, config_label, config, status, total, completed,
            summary, created_at, updated_at
       FROM eval_runs
      ORDER BY created_at DESC
      LIMIT 200`
  );
  return rows;
}

export async function getEvalRun(runId: string): Promise<{
  run: EvalRunRow | null;
  results: EvalResultRow[];
}> {
  const run = await queryRow<EvalRunRow>(
    `SELECT id, name, config_label, config, status, total, completed,
            summary, created_at, updated_at
       FROM eval_runs WHERE id = $1`,
    [runId]
  );
  if (!run) return { run: null, results: [] };
  const { rows: results } = await query<EvalResultRow>(
    `SELECT id, run_id, config_label, question, expected_module, response,
            confidence, latency_ms, has_12_blocks, status, error, created_at
       FROM eval_results WHERE run_id = $1 ORDER BY created_at ASC`,
    [runId]
  );
  return { run, results };
}

export function executeEvalRunFireAndForget(runId: string): void {
  // No await: corre en background.
  executeEvalRun(runId).catch((err) => {
    logger.error({ err, runId }, "eval: run execution fail");
  });
}

export async function executeEvalRun(runId: string): Promise<void> {
  const run = await queryRow<EvalRunRow>(
    `SELECT id, name, config_label, config, status, total, completed FROM eval_runs WHERE id = $1`,
    [runId]
  );
  if (!run) throw new Error("run no encontrado");
  if (run.status === "running" || run.status === "done") {
    logger.warn({ runId, status: run.status }, "eval: run ya estaba ejecutándose / terminado");
    return;
  }
  await query(`UPDATE eval_runs SET status='running', updated_at=now() WHERE id=$1`, [runId]);

  const cfg = run.config as EvalConfig;
  const systemPrompt = await loadPrompt();
  const client = getAi();

  const { rows: pending } = await query<EvalResultRow>(
    `SELECT id, question FROM eval_results WHERE run_id = $1 AND status = 'pending' ORDER BY created_at ASC`,
    [runId]
  );

  logger.info({ runId, label: cfg.label, count: pending.length }, "eval: run starting");

  for (const row of pending) {
    const t0 = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resp: any = await client.models.generateContent({
        model: cfg.model,
        contents: row.question,
        config: {
          systemInstruction: systemPrompt,
          maxOutputTokens: 4096,
          temperature: cfg.temperature ?? 0.4,
        },
      });
      const text = (resp.text ?? "").trim();
      const latencyMs = Date.now() - t0;
      const usage = extractUsage(resp);
      recordUsageFireAndForget({
        source: "eval",
        model: cfg.model,
        promptTokens:     usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens:      usage.totalTokens,
        metadata: { runId, configLabel: cfg.label },
      });
      const confidence = detectConfidence(text);
      const blocks12 = has12Blocks(text);
      await query(
        `UPDATE eval_results
            SET response=$1, confidence=$2, latency_ms=$3, has_12_blocks=$4,
                status='ok', error=NULL
          WHERE id=$5`,
        [text, confidence, latencyMs, blocks12, row.id]
      );
    } catch (err) {
      const latencyMs = Date.now() - t0;
      if (isQuotaError(err)) {
        await query(
          `UPDATE eval_results SET status='quota_error', latency_ms=$1, error=$2 WHERE id=$3`,
          [latencyMs, "Gemini quota 429", row.id]
        );
        logger.warn({ runId, label: cfg.label }, "eval: quota error, espero 25s y sigo");
        await new Promise((r) => setTimeout(r, 25_000));
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg = String((err as any)?.message ?? err).slice(0, 500);
        await query(
          `UPDATE eval_results SET status='error', latency_ms=$1, error=$2 WHERE id=$3`,
          [latencyMs, msg, row.id]
        );
      }
    }
    // Update progress
    await query(`UPDATE eval_runs SET completed = completed + 1, updated_at = now() WHERE id = $1`, [runId]);
  }

  const summary = await computeSummary(runId);
  await query(
    `UPDATE eval_runs SET status='done', summary=$1::jsonb, updated_at=now() WHERE id=$2`,
    [JSON.stringify(summary), runId]
  );
  logger.info({ runId, summary }, "eval: run done");
}

async function computeSummary(runId: string): Promise<EvalSummary> {
  const { rows } = await query<EvalResultRow>(
    `SELECT status, latency_ms, has_12_blocks, confidence FROM eval_results WHERE run_id=$1`,
    [runId]
  );
  const total = rows.length;
  const ok = rows.filter((r) => r.status === "ok").length;
  const errors = rows.filter((r) => r.status === "error").length;
  const quotaErrors = rows.filter((r) => r.status === "quota_error").length;
  const lats = rows.filter((r) => r.status === "ok" && r.latency_ms !== null).map((r) => r.latency_ms!);
  const avgLatencyMs = lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;
  const okWith12 = rows.filter((r) => r.status === "ok" && r.has_12_blocks).length;
  const pct12Blocks = ok > 0 ? Math.round((okWith12 / ok) * 100) : 0;
  const confidenceDist: Record<ConfidenceLevel, number> = {
    alta: 0, media: 0, baja: 0, no_detectada: 0,
  };
  for (const r of rows) {
    if (r.status === "ok" && r.confidence) confidenceDist[r.confidence]++;
  }
  return { total, ok, errors, quotaErrors, avgLatencyMs, pct12Blocks, confidenceDist };
}
