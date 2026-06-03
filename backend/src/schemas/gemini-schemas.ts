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

/** Map de tarea → schema. Tasks sin schema = texto libre. */
import type { LLMTaskType } from "../intelligence/task-router";
export const SCHEMA_BY_TASK: Partial<Record<LLMTaskType, Schema>> = {
  CLASSIFICATION: CLASSIFICATION_SCHEMA,
  CUSTOMER_RESPONSE: CUSTOMER_RESPONSE_SCHEMA,
  QUALITY_GATE: CUSTOMER_RESPONSE_SCHEMA,
  SUMMARY: SUMMARY_SCHEMA,
  ESTIMATION: SUMMARY_SCHEMA,
};
