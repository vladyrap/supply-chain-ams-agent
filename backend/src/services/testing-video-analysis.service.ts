// Análisis IA de video de Testing.
// Pipeline:
//   1. Leer archivo desde filesystem (storagePath de la evidencia).
//   2. Llamar a Whisper local (onerahmet/openai-whisper-asr-webservice) para transcript.
//   3. Pasar transcript a Gemini → extraer steps SAP estructurados.
//   4. Devolver { transcript, suggestedSteps, possibleErrors }.
//
// Si Gemini no está configurado, devuelve transcript + fallback simple (split por puntos).

import { logger } from "../utils/logger";
import * as testing from "./testing.service";
import { GoogleGenAI } from "@google/genai";

const WHISPER_URL = process.env.WHISPER_URL || "http://supply-chain-ams-whisper:9000";

export interface VideoAnalysisResult {
  evidenceId: string;
  transcript: string;
  language: string;
  durationSeconds: number | null;
  suggestedSteps: { order: number; action: string; data?: string; expectedResult: string }[];
  possibleErrors: string[];
  rawGeminiResponse?: string;
}

interface WhisperResponse {
  text?: string;
  language?: string;
  duration?: number;
}

async function callWhisper(buffer: Buffer, fileName: string, mimeType: string, language: string): Promise<WhisperResponse> {
  const fd = new FormData();
  fd.append("audio_file", new Blob([buffer], { type: mimeType }), fileName);
  const url = `${WHISPER_URL}/asr?task=transcribe&language=${encodeURIComponent(language)}&output=json&word_timestamps=false`;
  const resp = await fetch(url, { method: "POST", body: fd });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`whisper HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  return resp.json() as Promise<WhisperResponse>;
}

const GEMINI_PROMPT = `Sos un consultor SAP senior analizando la transcripción de una grabación de pantalla de un test funcional.
Tu tarea es extraer los PASOS REALIZADOS por el operador y los POSIBLES ERRORES observados.

Devolvé SÓLO JSON válido con este formato exacto:
{
  "suggestedSteps": [
    { "order": 1, "action": "Ingresar a MIGO", "data": "t-code MIGO", "expectedResult": "Pantalla inicial visible" }
  ],
  "possibleErrors": ["mensaje de error rojo en pantalla", "..."]
}

Reglas:
- order es 1-indexed.
- action: texto corto y accionable.
- data: opcional, datos clave (t-code, número OC, material, etc.).
- expectedResult: lo que debería pasar tras esa acción.
- Si no hay errores claros en el transcript, devolvé "possibleErrors": [].
- Máximo 12 pasos. Si el transcript es muy corto, devolvé 1-3 pasos como mínimo.
- NO inventes datos; basate sólo en el transcript.
- Devolvé SÓLO el JSON, sin texto extra, sin markdown.

Transcript:
"""
{{TRANSCRIPT}}
"""`;

async function extractStepsWithGemini(transcript: string): Promise<{ steps: VideoAnalysisResult["suggestedSteps"]; errors: string[]; raw: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Fallback determinístico
    const lines = transcript.split(/[.!\n]/).map((s) => s.trim()).filter((s) => s.length > 8).slice(0, 6);
    return {
      steps: lines.map((line, i) => ({
        order: i + 1,
        action: line.slice(0, 120),
        expectedResult: "Verificar resultado en pantalla",
      })),
      errors: [],
      raw: "(GEMINI_API_KEY no configurada — fallback determinístico)",
    };
  }

  try {
    const client = new GoogleGenAI({ apiKey });
    const prompt = GEMINI_PROMPT.replace("{{TRANSCRIPT}}", transcript.slice(0, 8000));
    const res = await client.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: prompt,
      config: { responseMimeType: "application/json" },
    });
    const text = (res as { text?: string }).text || "";
    // Parsear el JSON
    let parsed: { suggestedSteps?: VideoAnalysisResult["suggestedSteps"]; possibleErrors?: string[] } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      // Tratar de extraer JSON entre llaves
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }
    return {
      steps: parsed.suggestedSteps || [],
      errors: parsed.possibleErrors || [],
      raw: text,
    };
  } catch (err) {
    logger.warn({ err }, "gemini step extraction failed, using fallback");
    const lines = transcript.split(/[.!\n]/).map((s) => s.trim()).filter((s) => s.length > 8).slice(0, 6);
    return {
      steps: lines.map((line, i) => ({
        order: i + 1,
        action: line.slice(0, 120),
        expectedResult: "Verificar resultado en pantalla",
      })),
      errors: [],
      raw: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Analiza una evidencia de video que ya existe en el filesystem.
 * Devuelve transcript + pasos sugeridos. NO escribe nada en la DB —
 * el frontend decide si aplicarlos al escenario.
 */
export async function analyzeVideoEvidence(tenantId: string, evidenceId: string, language = "es"): Promise<VideoAnalysisResult> {
  const ev = await testing.getEvidence(tenantId, evidenceId);
  if (!ev) throw new Error("Evidencia no encontrada");
  if (!ev.storagePath) throw new Error("Esta evidencia no tiene archivo (probablemente fallback ObjectURL local)");
  if (ev.type !== "SCREEN_RECORDING" && ev.type !== "UPLOADED_VIDEO") {
    throw new Error(`Tipo de evidencia "${ev.type}" no soporta análisis de video`);
  }

  const buffer = await testing.readEvidenceFile(tenantId, ev.storagePath);
  logger.info({ evidenceId, bytes: buffer.length }, "testing video: enviando a Whisper");

  const whisper = await callWhisper(buffer, ev.fileName || "video.webm", ev.fileType || "video/webm", language);
  const transcript = (whisper.text || "").trim();
  logger.info({ evidenceId, transcriptChars: transcript.length }, "testing video: extrayendo pasos con Gemini");

  const { steps, errors, raw } = await extractStepsWithGemini(transcript);
  return {
    evidenceId,
    transcript,
    language: whisper.language || language,
    durationSeconds: whisper.duration ?? ev.durationSeconds ?? null,
    suggestedSteps: steps,
    possibleErrors: errors,
    rawGeminiResponse: raw,
  };
}
