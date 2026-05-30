// Auto-curación de patrones de feedback.
//
// Detecta clusters de feedback negativo con razones similares en los
// últimos N días usando embeddings. Si un cluster tiene >= minClusterSize
// instancias, crea una KnowledgeGap específica con sugerencia de
// artículo + score de prioridad.
//
// Estrategia simple:
//   1) Tomar feedback negativos recientes con reason no vacía.
//   2) Embebber cada reason.
//   3) Clustering aglomerativo greedy: agrupar embeddings con cosine
//      similarity >= 0.78.
//   4) Para cluster con >= 3 → crear gap.

import { GoogleGenAI } from "@google/genai";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import * as training from "./training.service";

const EMBED_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBED_DIM = parseInt(process.env.GEMINI_EMBEDDING_DIM || "768", 10);
const CLUSTER_SIMILARITY = 0.78;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

async function embed(text: string): Promise<number[]> {
  const ai = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp: any = await (ai.models as any).embedContent({
    model: EMBED_MODEL,
    contents: text.slice(0, 2000),
    config: { outputDimensionality: EMBED_DIM },
  });
  return resp.embedding?.values ?? resp.embeddings?.[0]?.values ?? null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

interface NegativeRow {
  id: string;
  source: string;
  reason: string;
  query: string | null;
  created_at: string;
}

interface Cluster {
  centroid: number[];
  members: { row: NegativeRow; vec: number[] }[];
  representativeReason: string;
}

export interface FeedbackPatternReport {
  scannedAt: string;
  totalNegatives: number;
  clustersFound: number;
  gapsCreated: number;
  clusters: {
    representativeReason: string;
    count: number;
    sources: string[];
    gapCreated: boolean;
    gapId: string | null;
  }[];
}

const MIN_CLUSTER_SIZE = 3;

export async function runFeedbackPatternDetection(opts: {
  daysBack?: number;
  minClusterSize?: number;
} = {}): Promise<FeedbackPatternReport> {
  const daysBack = Math.max(1, Math.min(60, opts.daysBack ?? 14));
  const minClusterSize = Math.max(2, opts.minClusterSize ?? MIN_CLUSTER_SIZE);

  // ensure schema kb_training_gaps
  await training.getSnapshot().catch(() => null);

  let negatives: NegativeRow[] = [];
  try {
    const { rows } = await query<NegativeRow>(
      `SELECT id, source, COALESCE(reason, '') AS reason, query, created_at
         FROM ai_response_feedback
        WHERE kind = 'negative'
          AND COALESCE(reason, '') <> ''
          AND created_at > now() - ($1 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT 200`,
      [String(daysBack)]
    );
    negatives = rows;
  } catch (err) {
    logger.debug({ err }, "feedback-patterns fetch fail");
  }

  const report: FeedbackPatternReport = {
    scannedAt: new Date().toISOString(),
    totalNegatives: negatives.length,
    clustersFound: 0,
    gapsCreated: 0,
    clusters: [],
  };
  if (negatives.length < minClusterSize) {
    logger.info({ count: negatives.length }, "feedback-patterns: not enough negatives");
    return report;
  }

  // Embeber todas las razones
  const embedded: { row: NegativeRow; vec: number[] }[] = [];
  for (const n of negatives) {
    try {
      const v = await embed(n.reason);
      if (v && v.length > 0) embedded.push({ row: n, vec: v });
    } catch (err) {
      logger.debug({ err, id: n.id }, "embed feedback reason fail");
    }
  }

  // Clustering greedy
  const clusters: Cluster[] = [];
  for (const e of embedded) {
    let assigned = false;
    for (const c of clusters) {
      if (cosine(e.vec, c.centroid) >= CLUSTER_SIMILARITY) {
        c.members.push(e);
        // actualizar centroide (promedio incremental)
        const n = c.members.length;
        for (let i = 0; i < c.centroid.length; i++) {
          c.centroid[i] = c.centroid[i] + (e.vec[i] - c.centroid[i]) / n;
        }
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push({
        centroid: [...e.vec],
        members: [e],
        representativeReason: e.row.reason,
      });
    }
  }

  const significantClusters = clusters
    .filter((c) => c.members.length >= minClusterSize)
    .sort((a, b) => b.members.length - a.members.length);

  report.clustersFound = significantClusters.length;

  // Existing gap signatures para deduplicar
  const existingSigs = new Set<string>();
  try {
    const { rows } = await query<{ title: string }>(
      `SELECT title FROM kb_training_gaps WHERE status IN ('OPEN','IN_PROGRESS')`
    );
    for (const r of rows) {
      const m = r.title.match(/^\[sig:fb-cluster:([^\]]+)\]/);
      if (m) existingSigs.add(m[1]);
    }
  } catch { /* */ }

  // Crear gap por cluster
  for (const c of significantClusters) {
    // signature = hash simple del representative reason
    const sig = simpleHash(c.representativeReason.toLowerCase().slice(0, 200));
    const alreadyExists = existingSigs.has(sig);
    const sources = Array.from(new Set(c.members.map((m) => m.row.source)));
    const sourcesLabel = sources.join(", ");
    const sample = c.members.slice(0, 3).map((m) => `· "${m.row.reason.slice(0, 80)}"`).join("\n");

    let gapId: string | null = null;
    if (!alreadyExists) {
      try {
        const gap = await training.createGap({
          title: `[sig:fb-cluster:${sig}] Patrón de feedback negativo · ${c.members.length} casos (${sourcesLabel})`,
          description: `Detectado patrón recurrente en feedback negativo de los últimos ${daysBack} días. Ejemplos:\n${sample}`,
          module: "AMS",
          process: "AMS Genérico",
          priority: c.members.length >= 5 ? "high" : "medium",
          suggestedAction: `Revisar las ${c.members.length} respuestas negativas que comparten esta razón. Crear KB article correctivo y considerar Q&A nueva en el training para que el agente no vuelva a fallar.`,
          status: "OPEN",
        });
        gapId = gap.id;
        report.gapsCreated++;
      } catch (err) {
        logger.warn({ err, sig }, "create gap from feedback cluster fail");
      }
    }

    report.clusters.push({
      representativeReason: c.representativeReason.slice(0, 200),
      count: c.members.length,
      sources,
      gapCreated: !!gapId,
      gapId,
    });
  }

  logger.info(report, "feedback-patterns run completed");
  return report;
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}
