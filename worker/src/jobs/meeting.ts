import { logger } from "../logger";
import { query } from "../db";
import { GoogleGenAI } from "@google/genai";
import { retryWithBackoff } from "../retry";
import { emitEvent } from "../emit";

const WHISPER_URL = process.env.WHISPER_URL || "http://supply-chain-ams-whisper:9000";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let ai: GoogleGenAI | null = null;
function getAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no definida");
  if (!ai) ai = new GoogleGenAI({ apiKey });
  return ai;
}

export interface MeetingJobData {
  meetingId: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
  language?: string;  // ISO 639-1, default "es"
  /** FIX (QAS MT v1.2.2): tenant_id obligatorio para evento + persistencia. */
  tenantId?: string;
}

interface WhisperResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: { start: number; end: number; text: string }[];
}

async function callWhisper(buffer: Buffer, fileName: string, mimeType: string, language: string): Promise<WhisperResponse> {
  // El servicio ASR de onerahmet/openai-whisper-asr-webservice acepta multipart en /asr
  // ?task=transcribe&language=es&output=json
  const url = `${WHISPER_URL}/asr?task=transcribe&language=${encodeURIComponent(language)}&output=json&word_timestamps=false`;
  const fd = new FormData();
  // Node 20+ tiene FormData global. Convertimos Buffer a Blob via Uint8Array.
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  fd.append("audio_file", blob, fileName);

  const resp = await fetch(url, { method: "POST", body: fd });
  if (!resp.ok) {
    throw new Error(`Whisper devolvió HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  return (await resp.json()) as WhisperResponse;
}

const MINUTE_PROMPT = `Eres un consultor AMS Supply Chain SAP que está revisando la transcripción de una reunión.
Extrae una minuta estructurada en JSON con esta forma EXACTA:
{
  "summary": "Resumen ejecutivo en 3-5 frases.",
  "topics": ["Tema 1", "Tema 2", "..."],
  "decisions": ["Decisión 1", "Decisión 2"],
  "actions": [
    {
      "action": "Texto de la acción",
      "owner": "Nombre o área propuesta (o 'sin asignar')",
      "due": "Fecha o ventana sugerida (o 'no_informado')",
      "priority": "alta|media|baja",
      "context_sap": "MM|SD|PP|WM|EWM|QM|PM|ARIBA|IBP|BTP|INTEGRACION|NO_INFORMADO"
    }
  ],
  "risks": ["Riesgo 1"],
  "follow_ups": ["Lo que queda pendiente para próxima reunión"],
  "attendees": ["Persona 1", "Persona 2"]
}

Reglas:
- Responde SOLO el JSON puro, sin envolturas markdown, sin texto extra.
- Si un campo no tiene contenido, devuélvelo como [] o "" según el tipo.
- Sé breve y concreto; el destino es un seguimiento operativo, no narrativa.
- En "context_sap" pon el módulo SAP que mejor describa la acción.`;

function safeJsonParse(s: string): Record<string, unknown> | null {
  if (!s) return null;
  // Quitar fences markdown si vinieran
  const cleaned = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned) as Record<string, unknown>; } catch { /* noop */ }
  // Intento de rescate: tomar entre el primer { y el último }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>; } catch { /* noop */ }
  }
  return null;
}

interface Minute {
  summary?: string;
  topics?: string[];
  decisions?: string[];
  actions?: { action: string; owner?: string; due?: string; priority?: string; context_sap?: string }[];
  risks?: string[];
  follow_ups?: string[];
  attendees?: string[];
}

async function extractMinute(transcript: string): Promise<Minute> {
  const client = getAI();
  const userContent = `Transcripción de la reunión:\n\n${transcript}\n\nGenera la minuta JSON ahora.`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resp: any = await retryWithBackoff(
    () => client.models.generateContent({
      model: GEMINI_MODEL,
      contents: userContent,
      config: {
        systemInstruction: MINUTE_PROMPT,
        maxOutputTokens: 4096,
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    }),
    { label: "gemini.minute", retries: 2 }
  );
  const text = (resp.text ?? "").trim();
  const parsed = safeJsonParse(text);
  return (parsed ?? {}) as Minute;
}

function actionsToText(actions: Minute["actions"]): string {
  if (!actions || actions.length === 0) return "";
  return actions.map((a, i) =>
    `${i + 1}. [${a.priority || "?"}] ${a.action} — owner: ${a.owner || "sin_asignar"} · vence: ${a.due || "—"}`
  ).join("\n");
}

export async function processMeeting(data: MeetingJobData): Promise<void> {
  const { meetingId, dataBase64, fileName, mimeType, language = "es" } = data;
  try {
    await query(`UPDATE meetings SET status='transcribing' WHERE id=$1`, [meetingId]);
    logger.info({ meetingId, fileName }, "meeting: transcribiendo con whisper");
    const buffer = Buffer.from(dataBase64, "base64");
    const whisperResp = await callWhisper(buffer, fileName, mimeType, language);
    const transcript = (whisperResp.text || "").trim();
    if (!transcript || transcript.length < 10) {
      throw new Error("Transcripción vacía (audio inaudible o muy corto)");
    }

    await query(
      `UPDATE meetings SET status='extracting', transcript=$1, duration_sec=$2 WHERE id=$3`,
      [transcript, whisperResp.duration ?? null, meetingId]
    );
    logger.info({ meetingId, chars: transcript.length, duration: whisperResp.duration }, "meeting: extrayendo minuta");
    const minute = await extractMinute(transcript);
    const summary = minute.summary ?? "";
    const actionsText = actionsToText(minute.actions);

    await query(
      `UPDATE meetings
          SET status='done',
              summary=$1,
              minute=$2::jsonb,
              actions_text=$3,
              processed_at=now(),
              error_message=NULL
        WHERE id=$4`,
      [summary, JSON.stringify(minute), actionsText, meetingId]
    );
    logger.info({ meetingId }, "meeting: done");

    // Emit cross-service (no crítico). FIX QAS MT v1.2.2: tenantId obligatorio.
    const tenantIdForEmit = (data as MeetingJobData).tenantId || "default";
    emitEvent(tenantIdForEmit, "meeting.done", {
      tenant_id: tenantIdForEmit,
      meeting_id: meetingId,
      title: fileName,
      duration_sec: whisperResp.duration ?? null,
      actions_count: minute.actions?.length ?? 0,
      attendees_count: minute.attendees?.length ?? 0,
      summary: summary.slice(0, 300),
    }).catch(() => undefined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, meetingId }, "meeting: fail");
    await query(
      `UPDATE meetings SET status='error', error_message=$1 WHERE id=$2`,
      [msg.slice(0, 500), meetingId]
    );
  }
}
