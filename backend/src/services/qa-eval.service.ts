// QA Evaluation — regression test del agente contra Q&A aprobadas.
//
// Para cada Q&A aprobada en kb_training_qa:
//   1) Ejecutamos el agente con su question como query
//   2) Comparamos la respuesta del agente con expected_answer usando
//      Gemini como juez (score 0..100 + veredicto)
//   3) Acumulamos resultados → eval_runs / eval_results
//
// Diseñado para correr on-demand (botón en UI) o por cron (futuro).
// Limita el batch para no quemar quota gratis del API.

import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import { ConfigError, ClaudeError } from "../utils/errors";
import { extractUsage } from "./usage.service";

const JUDGE_MODEL = "gemini-2.5-flash";
const DEFAULT_BATCH = 20;
const MAX_BATCH = 100;

let cachedClient: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new ConfigError("GEMINI_API_KEY no configurada");
  if (!cachedClient) cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS qa_eval_runs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        triggered_by    TEXT NOT NULL DEFAULT 'sistema',
        total_qas       INTEGER NOT NULL DEFAULT 0,
        passed          INTEGER NOT NULL DEFAULT 0,
        failed          INTEGER NOT NULL DEFAULT 0,
        avg_score       REAL NOT NULL DEFAULT 0,
        prompt_label    TEXT,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at     TIMESTAMPTZ
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS qa_eval_results (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id        UUID NOT NULL REFERENCES qa_eval_runs(id) ON DELETE CASCADE,
        qa_id         UUID NOT NULL,
        item_id       UUID,
        question      TEXT NOT NULL,
        expected      TEXT NOT NULL,
        actual        TEXT NOT NULL,
        score         INTEGER NOT NULL,
        verdict       TEXT NOT NULL,
        notes         TEXT,
        latency_ms    INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_qa_eval_results_run ON qa_eval_results(run_id);`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure qa_eval schema failed");
  }
}

export interface EvalSingleResult {
  qaId: string;
  itemId: string | null;
  question: string;
  expected: string;
  actual: string;
  score: number;
  verdict: "pass" | "partial" | "fail";
  notes: string;
  latencyMs: number;
}

export interface EvalRunReport {
  runId: string;
  totalQas: number;
  passed: number;
  failed: number;
  partial: number;
  avgScore: number;
  promptLabel: string | null;
  durationMs: number;
  results: EvalSingleResult[];
}

async function callAgent(
  question: string,
  module: string | null,
  systemPromptOverride?: string,
): Promise<{ text: string; latencyMs: number }> {
  const start = Date.now();
  // Si hay override, hacemos llamada directa a Gemini con ese system prompt.
  // Sino, usamos chatWithAgent del claude.service (agente real con prompt activo + few-shot).
  if (systemPromptOverride && systemPromptOverride.trim()) {
    const ai = getClient();
    try {
      const resp = await ai.models.generateContent({
        model: JUDGE_MODEL,
        contents: question,
        config: {
          systemInstruction: systemPromptOverride,
          maxOutputTokens: 1024,
          temperature: 0.4,
        },
      });
      const text = (resp.text ?? "").trim() || "(respuesta vacía)";
      return { text, latencyMs: Date.now() - start };
    } catch (err) {
      logger.warn({ err }, "callAgent override fail");
      return { text: `(error con prompt override: ${err instanceof Error ? err.message : "desconocido"})`, latencyMs: Date.now() - start };
    }
  }
  const { chatWithAgent } = await import("./claude.service");
  const r = await chatWithAgent({
    userMessage: question,
    user: "qa-eval",
    module: module ?? "AMS",
    client: "internal",
    environment: "DEV",
  });
  return { text: r.text, latencyMs: Date.now() - start };
}

interface JudgeJson {
  score?: number;
  verdict?: string;
  notes?: string;
}

async function judgeWithGemini(question: string, expected: string, actual: string): Promise<{ score: number; verdict: "pass" | "partial" | "fail"; notes: string }> {
  const ai = getClient();
  const prompt = `
Sos un evaluador estricto de respuestas de un agente IA de soporte AMS Supply Chain SAP.
Tu tarea: comparar la RESPUESTA REAL del agente con la RESPUESTA ESPERADA y dar un score.

Pregunta del usuario:
${question}

Respuesta esperada (curada por el equipo AMS):
${expected}

Respuesta real del agente:
${actual}

Criterios:
- Score 90-100 → contiene la solución correcta, transacciones SAP correctas, pasos completos.
- Score 70-89 → contiene la idea principal pero omite detalles o transacciones específicas.
- Score 40-69 → menciona el tema pero la solución es inexacta o muy incompleta.
- Score 0-39 → respuesta incorrecta, alucinación o fuera de tema.

Devolvé SOLO JSON con esta forma exacta, sin markdown ni texto extra:
{
  "score": 0-100,
  "verdict": "pass" | "partial" | "fail",
  "notes": "1-2 oraciones explicando el score"
}

Reglas:
- verdict = "pass" si score >= 75
- verdict = "partial" si 40 <= score < 75
- verdict = "fail" si score < 40
- notes en español, breve y específica (qué falta o qué está mal)
`.trim();

  try {
    const resp = await ai.models.generateContent({
      model: JUDGE_MODEL,
      contents: prompt,
      config: {
        systemInstruction: "Sos un evaluador objetivo. Devolvé SOLO JSON válido.",
        responseMimeType: "application/json",
        maxOutputTokens: 256,
        temperature: 0.1,
      },
    });
    extractUsage(resp); // tracking
    const text = (resp.text ?? "").trim();
    let parsed: JudgeJson = {};
    try { parsed = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } }
    }
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
    const verdict =
      parsed.verdict === "pass" || parsed.verdict === "partial" || parsed.verdict === "fail"
        ? parsed.verdict
        : (score >= 75 ? "pass" : score >= 40 ? "partial" : "fail");
    const notes = typeof parsed.notes === "string" ? parsed.notes : "";
    return { score, verdict, notes };
  } catch (err) {
    logger.warn({ err }, "judge gemini fail");
    return { score: 0, verdict: "fail", notes: "Error del juez Gemini (timeout o quota)" };
  }
}

export async function runQaEvaluation(opts: {
  limit?: number;
  triggeredBy?: string;
  /** Si se pasa, se usa este system prompt en lugar del activo del agente */
  systemPromptOverride?: string;
  /** Label opcional para este run (útil en A/B) */
  promptLabelOverride?: string;
} = {}): Promise<EvalRunReport> {
  await ensureSchema();
  const limit = Math.max(1, Math.min(MAX_BATCH, opts.limit ?? DEFAULT_BATCH));

  // 1. Leer prompt activo (solo para registrarlo en el run)
  let promptLabel: string | null = opts.promptLabelOverride ?? null;
  if (!promptLabel) {
    try {
      const { getActivePrompt } = await import("./agent-lab.service");
      const v = await getActivePrompt();
      if (v) promptLabel = v.label;
    } catch { /* ignore */ }
  }

  // 2. Crear run
  const { rows: runRows } = await query<{ id: string }>(
    `INSERT INTO qa_eval_runs (triggered_by, prompt_label) VALUES ($1, $2) RETURNING id`,
    [opts.triggeredBy ?? "sistema", promptLabel]
  );
  const runId = runRows[0]!.id;

  // 3. Tomar Q&A aprobadas a evaluar
  const { rows: qas } = await query<{
    id: string; question: string; expected_answer: string;
    knowledge_item_id: string | null;
    item_module: string | null;
  }>(
    `SELECT q.id, q.question, q.expected_answer, q.knowledge_item_id,
            i.module AS item_module
       FROM kb_training_qa q
       LEFT JOIN kb_training_items i ON i.id = q.knowledge_item_id
      WHERE q.approved = true
      ORDER BY q.created_at DESC
      LIMIT $1`,
    [limit]
  );

  if (qas.length === 0) {
    await query(
      `UPDATE qa_eval_runs SET total_qas = 0, passed = 0, failed = 0, finished_at = now() WHERE id = $1`,
      [runId]
    );
    return {
      runId, totalQas: 0, passed: 0, failed: 0, partial: 0, avgScore: 0,
      promptLabel, durationMs: 0, results: [],
    };
  }

  // 4. Para cada Q&A: ejecutar agente + juez
  const results: EvalSingleResult[] = [];
  const start = Date.now();
  for (const qa of qas) {
    try {
      const { text: actual, latencyMs } = await callAgent(qa.question, qa.item_module, opts.systemPromptOverride);
      const judged = await judgeWithGemini(qa.question, qa.expected_answer, actual);
      const result: EvalSingleResult = {
        qaId: qa.id,
        itemId: qa.knowledge_item_id,
        question: qa.question,
        expected: qa.expected_answer,
        actual,
        score: judged.score,
        verdict: judged.verdict,
        notes: judged.notes,
        latencyMs,
      };
      results.push(result);
      // Persistir cada resultado individual
      await query(
        `INSERT INTO qa_eval_results
           (run_id, qa_id, item_id, question, expected, actual, score, verdict, notes, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          runId, qa.id, qa.knowledge_item_id,
          qa.question, qa.expected_answer, actual,
          judged.score, judged.verdict, judged.notes, latencyMs,
        ]
      );
    } catch (err) {
      logger.warn({ err, qaId: qa.id }, "qa-eval item fail");
      const failedResult: EvalSingleResult = {
        qaId: qa.id,
        itemId: qa.knowledge_item_id,
        question: qa.question,
        expected: qa.expected_answer,
        actual: "(error ejecutando agente)",
        score: 0,
        verdict: "fail",
        notes: err instanceof Error ? err.message : "error desconocido",
        latencyMs: 0,
      };
      results.push(failedResult);
    }
  }

  const passed = results.filter((r) => r.verdict === "pass").length;
  const partial = results.filter((r) => r.verdict === "partial").length;
  const failed = results.filter((r) => r.verdict === "fail").length;
  const avgScore = results.length
    ? Math.round(results.reduce((a, r) => a + r.score, 0) / results.length)
    : 0;
  const durationMs = Date.now() - start;

  await query(
    `UPDATE qa_eval_runs
        SET total_qas = $1, passed = $2, failed = $3, avg_score = $4, finished_at = now()
      WHERE id = $5`,
    [results.length, passed, failed, avgScore, runId]
  );

  const report: EvalRunReport = {
    runId, totalQas: results.length, passed, failed, partial, avgScore,
    promptLabel, durationMs, results,
  };
  logger.info({ ...report, results: undefined }, "qa-eval run completed");
  return report;
}

// ============================================================================
// Históricos
// ============================================================================
export interface EvalRunSummary {
  id: string;
  triggered_by: string;
  total_qas: number;
  passed: number;
  failed: number;
  avg_score: number;
  prompt_label: string | null;
  started_at: string;
  finished_at: string | null;
}

export async function listEvalRuns(limit = 30): Promise<EvalRunSummary[]> {
  await ensureSchema();
  const { rows } = await query<EvalRunSummary>(
    `SELECT id, triggered_by, total_qas, passed, failed, avg_score,
            prompt_label, started_at, finished_at
       FROM qa_eval_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(200, limit))]
  );
  return rows;
}

export interface EvalRunDetail extends EvalRunSummary {
  results: EvalSingleResult[];
}

export async function getEvalRunDetail(runId: string): Promise<EvalRunDetail | null> {
  await ensureSchema();
  const { rows: runs } = await query<EvalRunSummary>(
    `SELECT * FROM qa_eval_runs WHERE id = $1 LIMIT 1`, [runId]
  );
  if (runs.length === 0) return null;
  const { rows: res } = await query<{
    qa_id: string; item_id: string | null; question: string; expected: string;
    actual: string; score: number; verdict: string; notes: string; latency_ms: number;
  }>(
    `SELECT qa_id, item_id, question, expected, actual, score, verdict, notes, latency_ms
       FROM qa_eval_results
      WHERE run_id = $1
      ORDER BY created_at ASC`,
    [runId]
  );
  return {
    ...runs[0],
    results: res.map((r) => ({
      qaId: r.qa_id, itemId: r.item_id,
      question: r.question, expected: r.expected, actual: r.actual,
      score: r.score, verdict: r.verdict as "pass" | "partial" | "fail",
      notes: r.notes ?? "",
      latencyMs: r.latency_ms,
    })),
  };
}

// ============================================================================
// A/B testing — corre 2 evals con prompts distintos y devuelve comparación
// ============================================================================
export interface AbTestInput {
  /** Variante A: si se omite, usa el prompt activo del agente */
  promptA?: { systemPrompt: string; label: string };
  /** Variante B: prompt candidato a evaluar */
  promptB: { systemPrompt: string; label: string };
  limit?: number;
  triggeredBy?: string;
}

export interface AbTestReport {
  runA: EvalRunReport;
  runB: EvalRunReport;
  winner: "A" | "B" | "tie";
  scoreDelta: number;          // runB.avgScore - runA.avgScore
  passDelta: number;           // runB.passed - runA.passed
  improvedQas: string[];       // qaIds donde B > A
  degradedQas: string[];       // qaIds donde B < A
  unchangedQas: string[];
}

export async function runAbTest(input: AbTestInput): Promise<AbTestReport> {
  // Corremos A primero (sin override = activo), luego B con override
  const runA = await runQaEvaluation({
    limit: input.limit,
    triggeredBy: (input.triggeredBy ?? "ab-test") + ":A",
    systemPromptOverride: input.promptA?.systemPrompt,
    promptLabelOverride: input.promptA?.label ?? "(activo)",
  });
  const runB = await runQaEvaluation({
    limit: input.limit,
    triggeredBy: (input.triggeredBy ?? "ab-test") + ":B",
    systemPromptOverride: input.promptB.systemPrompt,
    promptLabelOverride: input.promptB.label,
  });

  // Comparar Q&A por Q&A
  const mapA = new Map(runA.results.map((r) => [r.qaId, r]));
  const mapB = new Map(runB.results.map((r) => [r.qaId, r]));
  const allIds = new Set([...mapA.keys(), ...mapB.keys()]);
  const improvedQas: string[] = [];
  const degradedQas: string[] = [];
  const unchangedQas: string[] = [];
  for (const id of allIds) {
    const a = mapA.get(id), b = mapB.get(id);
    const sa = a?.score ?? 0, sb = b?.score ?? 0;
    if (sb > sa + 2) improvedQas.push(id);
    else if (sb < sa - 2) degradedQas.push(id);
    else unchangedQas.push(id);
  }

  const scoreDelta = runB.avgScore - runA.avgScore;
  const passDelta = runB.passed - runA.passed;
  const winner: "A" | "B" | "tie" =
    Math.abs(scoreDelta) <= 1 ? "tie"
    : scoreDelta > 0 ? "B"
    : "A";

  return { runA, runB, winner, scoreDelta, passDelta, improvedQas, degradedQas, unchangedQas };
}

// ============================================================================
// AUTO-PROMOTE — si una variante gana por ≥ minDelta puntos, se adopta sola
// ============================================================================
export interface AutoPromoteInput {
  candidate: { systemPrompt: string; label: string; temperature?: number; maxTokens?: number };
  /** Mínimo score delta para auto-adoptar (default 5) */
  minDelta?: number;
  limit?: number;
  triggeredBy?: string;
  /** Si false, devuelve la recomendación pero NO adopta */
  apply?: boolean;
}

export interface AutoPromoteResult {
  decision: "adopted" | "skipped" | "no_change_needed";
  reason: string;
  abTest: AbTestReport;
  /** Solo presente si decision === "adopted" */
  newActiveVersionId?: string;
}

// ============================================================================
// COMPARADOR de dos runs existentes
// ============================================================================
export interface RunDiffResult {
  qaId: string;
  question: string;
  scoreA: number; scoreB: number; delta: number;
  verdictA: "pass" | "partial" | "fail";
  verdictB: "pass" | "partial" | "fail";
  status: "improved" | "degraded" | "unchanged" | "only_a" | "only_b";
}

export interface RunDiffReport {
  runA: EvalRunSummary;
  runB: EvalRunSummary;
  scoreDelta: number;
  passDelta: number;
  improved: RunDiffResult[];
  degraded: RunDiffResult[];
  unchanged: RunDiffResult[];
  onlyA: RunDiffResult[];
  onlyB: RunDiffResult[];
}

export async function diffEvalRuns(idA: string, idB: string): Promise<RunDiffReport | null> {
  const [a, b] = await Promise.all([getEvalRunDetail(idA), getEvalRunDetail(idB)]);
  if (!a || !b) return null;

  const mapA = new Map(a.results.map((r) => [r.qaId, r]));
  const mapB = new Map(b.results.map((r) => [r.qaId, r]));
  const allIds = new Set([...mapA.keys(), ...mapB.keys()]);

  const improved: RunDiffResult[] = [];
  const degraded: RunDiffResult[] = [];
  const unchanged: RunDiffResult[] = [];
  const onlyA: RunDiffResult[] = [];
  const onlyB: RunDiffResult[] = [];

  for (const id of allIds) {
    const ra = mapA.get(id);
    const rb = mapB.get(id);
    if (ra && !rb) {
      onlyA.push({
        qaId: id, question: ra.question,
        scoreA: ra.score, scoreB: 0, delta: -ra.score,
        verdictA: ra.verdict, verdictB: "fail",
        status: "only_a",
      });
      continue;
    }
    if (!ra && rb) {
      onlyB.push({
        qaId: id, question: rb.question,
        scoreA: 0, scoreB: rb.score, delta: rb.score,
        verdictA: "fail", verdictB: rb.verdict,
        status: "only_b",
      });
      continue;
    }
    if (ra && rb) {
      const delta = rb.score - ra.score;
      const r: RunDiffResult = {
        qaId: id, question: ra.question,
        scoreA: ra.score, scoreB: rb.score, delta,
        verdictA: ra.verdict, verdictB: rb.verdict,
        status: delta > 2 ? "improved" : delta < -2 ? "degraded" : "unchanged",
      };
      if (r.status === "improved") improved.push(r);
      else if (r.status === "degraded") degraded.push(r);
      else unchanged.push(r);
    }
  }

  improved.sort((x, y) => y.delta - x.delta);
  degraded.sort((x, y) => x.delta - y.delta);

  // a.summary y b.summary están en la fila del run sin el campo "results"
  const runA: EvalRunSummary = {
    id: a.id, triggered_by: a.triggered_by, total_qas: a.total_qas,
    passed: a.passed, failed: a.failed, avg_score: a.avg_score,
    prompt_label: a.prompt_label, started_at: a.started_at, finished_at: a.finished_at,
  };
  const runB: EvalRunSummary = {
    id: b.id, triggered_by: b.triggered_by, total_qas: b.total_qas,
    passed: b.passed, failed: b.failed, avg_score: b.avg_score,
    prompt_label: b.prompt_label, started_at: b.started_at, finished_at: b.finished_at,
  };

  return {
    runA, runB,
    scoreDelta: b.avg_score - a.avg_score,
    passDelta: b.passed - a.passed,
    improved, degraded, unchanged, onlyA, onlyB,
  };
}

export async function autoPromoteIfBetter(input: AutoPromoteInput): Promise<AutoPromoteResult> {
  const minDelta = Math.max(1, input.minDelta ?? 5);
  const ab = await runAbTest({
    promptB: { systemPrompt: input.candidate.systemPrompt, label: input.candidate.label },
    limit: input.limit,
    triggeredBy: input.triggeredBy ?? "auto-promote",
  });

  // Si runA tiene 0 Q&A, no podemos comparar
  if (ab.runA.totalQas === 0) {
    return {
      decision: "skipped",
      reason: "No hay Q&A aprobadas para evaluar. Generá Q&A primero y aprobalas.",
      abTest: ab,
    };
  }

  if (ab.scoreDelta < minDelta) {
    return {
      decision: "skipped",
      reason: `Delta de score (${ab.scoreDelta}) por debajo del mínimo requerido (${minDelta}). Mantengo el prompt activo.`,
      abTest: ab,
    };
  }
  if (ab.winner !== "B") {
    return {
      decision: "no_change_needed",
      reason: "El candidato no superó al prompt activo. Sin cambios.",
      abTest: ab,
    };
  }

  if (input.apply === false) {
    return {
      decision: "no_change_needed",
      reason: `Candidato ganaría por +${ab.scoreDelta} (≥ ${minDelta}). Solo análisis, no se adoptó.`,
      abTest: ab,
    };
  }

  // Adoptar
  try {
    const { adoptPrompt } = await import("./agent-lab.service");
    const adopted = await adoptPrompt({
      label: input.candidate.label,
      systemPrompt: input.candidate.systemPrompt,
      temperature: input.candidate.temperature,
      maxTokens: input.candidate.maxTokens,
      createdBy: "auto-promote",
      adoptionNotes: `Auto-adoptado tras ganar A/B por +${ab.scoreDelta} pts (run B ${ab.runB.runId.slice(0, 8)}). Mejoró ${ab.improvedQas.length} Q&A, degradó ${ab.degradedQas.length}.`,
    });
    return {
      decision: "adopted",
      reason: `Candidato adoptado automáticamente. Ganó por +${ab.scoreDelta} pts sobre el prompt activo.`,
      abTest: ab,
      newActiveVersionId: adopted.id,
    };
  } catch (err) {
    logger.error({ err }, "auto-promote adopt fail");
    return {
      decision: "skipped",
      reason: `Error adoptando: ${err instanceof Error ? err.message : "desconocido"}`,
      abTest: ab,
    };
  }
}
