// =============================================================================
// Gemini Response Schemas v0.13 — JSON Schemas para structured output
// =============================================================================
// Pasados al SDK Gemini via `responseSchema` en generateContent config.
// El SDK los soporta como subset de OpenAPI 3.0.3.
//
// Estos schemas NO se usan para validar runtime (eso lo hace `parseOrRepair`);
// se mandan al modelo para que produzca JSON ajustado a la forma esperada.
// =============================================================================

import type { Schema } from "@google/genai";
import { Type } from "@google/genai";

/** CLASSIFICATION — clasificación rápida de un ticket. */
export const CLASSIFICATION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    primaryModule: {
      type: Type.STRING,
      description: "Módulo SAP primario (MM, SD, WM, EWM, PP, FI, CO, BASIS, ABAP, INTEGRATIONS, UNKNOWN)",
    },
    secondaryModules: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    detectedTransactions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    detectedErrorCodes: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    summary: { type: Type.STRING },
    probableCause: { type: Type.STRING, nullable: true },
    missingData: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    estimatedComplexity: {
      type: Type.STRING,
      description: "LOW | MEDIUM | HIGH",
    },
    canResolveAtN1: { type: Type.BOOLEAN },
    confidence: {
      type: Type.STRING,
      description: "alta | media | baja",
    },
  },
  required: [
    "primaryModule", "summary", "estimatedComplexity",
    "canResolveAtN1", "confidence",
  ],
};

/** CUSTOMER_RESPONSE_REFINEMENT — segunda pasada sobre un borrador determinístico. */
export const CUSTOMER_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    customerSafeResponse: { type: Type.STRING },
    internalAMSNotes: { type: Type.STRING },
    wasModified: { type: Type.BOOLEAN },
    modificationsApplied: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    riskWarnings: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    confidence: { type: Type.STRING },
  },
  required: ["customerSafeResponse", "internalAMSNotes", "wasModified", "confidence"],
};

/** SUMMARY — resumen estructurado de cualquier contenido. */
export const SUMMARY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    tldr: { type: Type.STRING },
    keyFacts: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    openQuestions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    nextSteps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    confidence: { type: Type.STRING },
  },
  required: ["tldr", "confidence"],
};

/**
 * INVESTIGATION — reinvestigación completa del caso. El modelo NO actualiza una
 * respuesta previa: reconstruye toda la hipótesis desde cero con el paquete de
 * evidencia. Salida de 10 secciones + diff explícito contra la versión previa.
 */
export const INVESTIGATION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    executiveSummary: { type: Type.STRING },
    currentUnderstanding: { type: Type.STRING },
    evidenceConsidered: {
      type: Type.OBJECT,
      properties: {
        original: { type: Type.ARRAY, items: { type: Type.STRING } },
        new: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    rootCauseAnalysis: { type: Type.STRING },
    probableRootCause: { type: Type.STRING, nullable: true },
    hypotheses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          statement: { type: Type.STRING },
          confidence: { type: Type.STRING, description: "alta | media | baja" },
          status: { type: Type.STRING, description: "new | gained_confidence | lost_confidence | discarded | unchanged" },
        },
        required: ["statement", "confidence", "status"],
      },
    },
    findings: {
      type: Type.OBJECT,
      properties: {
        new: { type: Type.ARRAY, items: { type: Type.STRING } },
        modified: { type: Type.ARRAY, items: { type: Type.STRING } },
        removed: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    recommendations: { type: Type.ARRAY, items: { type: Type.STRING } },
    confidenceLevel: { type: Type.STRING, description: "alta | media | baja" },
    knowledgeLearned: { type: Type.STRING },
    changesVsPrevious: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        hypothesesDiscarded: { type: Type.ARRAY, items: { type: Type.STRING } },
        hypothesesGainedConfidence: { type: Type.ARRAY, items: { type: Type.STRING } },
        findingsRemoved: { type: Type.ARRAY, items: { type: Type.STRING } },
        recommendationsChanged: { type: Type.ARRAY, items: { type: Type.STRING } },
        rootCauseChanged: { type: Type.BOOLEAN },
        why: { type: Type.STRING },
      },
    },
  },
  required: [
    "executiveSummary", "currentUnderstanding", "rootCauseAnalysis",
    "hypotheses", "recommendations", "confidenceLevel",
  ],
};

/** Map de tarea → schema. Tasks sin schema = texto libre. */
import type { LLMTaskType } from "../intelligence/task-router";
export const SCHEMA_BY_TASK: Partial<Record<LLMTaskType, Schema>> = {
  CLASSIFICATION: CLASSIFICATION_SCHEMA,
  CUSTOMER_RESPONSE: CUSTOMER_RESPONSE_SCHEMA,
  QUALITY_GATE: CUSTOMER_RESPONSE_SCHEMA,
  SUMMARY: SUMMARY_SCHEMA,
  ESTIMATION: SUMMARY_SCHEMA,
  INVESTIGATION: INVESTIGATION_SCHEMA,
};
