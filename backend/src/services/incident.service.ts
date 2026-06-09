import { query } from "../database/db";
import { upsertSearchFireAndForget } from "./search.service";
import type {
  IncidentRecord,
  AmsChatInputNormalized,
  ConfidenceLevel,
  Attachment,
} from "../types/ams.types";
import {
  ensureEstimateSchema, enrichIncidentLazy, estimateIncident,
} from "./ticket-estimate.service";
import type {
  TicketEstimatedResolution, EnvironmentLevel,
} from "../utils/estimation";

// MT-2 (multi-tenant): incidents se aíslan por tenant_id. Todas las
// queries filtran por tenant + INSERT incluye la columna.

// Extiende IncidentRecord opcionalmente con la estimación autoembebida.
export type IncidentWithEstimate = IncidentRecord & {
  estimatedResolution?: TicketEstimatedResolution | null;
};

export interface SaveIncidentInput {
  input: AmsChatInputNormalized;
  response: string;
  confidence: ConfidenceLevel;
  model: string;
}

// Lo que guardamos en la columna jsonb: incluye el base64 (Fase 1).
// En Fase 3 migraremos a MinIO/S3 y aqui quedaria solo metadata + url.
function serializeAttachments(items: Attachment[]) {
  return items.map((a) => ({
    name: a.name,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    dataBase64: a.dataBase64,
  }));
}

interface IncidentRowRaw extends Omit<IncidentRecord, "attachments"> {
  attachments: unknown;
}

function rowToRecord(row: IncidentRowRaw): IncidentRecord {
  const att = Array.isArray(row.attachments) ? (row.attachments as unknown[]) : [];
  return {
    ...row,
    attachments: att.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        name: typeof o.name === "string" ? o.name : "adjunto",
        mimeType: typeof o.mimeType === "string" ? o.mimeType : "application/octet-stream",
        sizeBytes: typeof o.sizeBytes === "number" ? o.sizeBytes : 0,
      };
    }),
  };
}

export async function saveIncident(tenantId: string, data: SaveIncidentInput): Promise<IncidentWithEstimate> {
  const { input, response, confidence, model } = data;
  // 1. INSERT base (sin estimación) para tener el id real
  const { rows } = await query<IncidentRowRaw>(
    `INSERT INTO incidents
       (tenant_id, user_name, client_name, sap_module, environment, message, response,
        confidence, model, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING id, user_name, client_name, sap_module, environment, message, response,
               confidence, model, attachments, created_at`,
    [
      tenantId,
      input.user,
      input.client,
      input.module,
      input.environment,
      input.message,
      response,
      confidence,
      model,
      JSON.stringify(serializeAttachments(input.attachments)),
    ]
  );
  const rec = rowToRecord(rows[0]!);

  // 2. Autoestimación inmediata + UPDATE de la columna jsonb (lazy schema)
  let estimatedResolution: TicketEstimatedResolution | null = null;
  try {
    await ensureEstimateSchema();
    const envU = String(input.environment ?? "NO_INFORMADO").toUpperCase() as EnvironmentLevel;
    estimatedResolution = estimateIncident({
      ticketId: rec.id,
      origin: "agent_chat",
      kind: "incident",
      title: input.message.slice(0, 80),
      description: input.message,
      sapModule: input.module || undefined,
      environment: envU,
      isProductive: envU === "PRD",
      agentConfidence: confidence,
      hasErrorEvidence: input.attachments.length > 0,
    });
    await query(
      `UPDATE incidents SET estimated_resolution = $1::jsonb WHERE id = $2 AND tenant_id = $3`,
      [JSON.stringify(estimatedResolution), rec.id, tenantId]
    );
  } catch (err) {
    // No bloqueamos la creación del incidente si la autoestimación falla.
    // El próximo GET aplicará enrichIncidentLazy automáticamente.
    estimatedResolution = null;
  }

  // 3. Indexar en búsqueda semántica (no bloqueante)
  upsertSearchFireAndForget({
    source_type: "incident",
    source_id: rec.id,
    title: rec.message.slice(0, 120),
    excerpt: (rec.response ?? "").slice(0, 800),
    href: "/history",
    metadata: { module: rec.sap_module, client: rec.client_name, confidence: rec.confidence },
  });
  return { ...rec, estimatedResolution };
}

// Para los listados NO devolvemos el base64 (puede pesar varios MB).
// Devolvemos solo metadata: nombre, mimeType, sizeBytes.
// Sí devolvemos estimated_resolution para que la lista muestre la banda y la confianza.
const LIST_SELECT = `
  id, user_name, client_name, sap_module, environment, message, response,
  confidence, model,
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
      'name',      a->>'name',
      'mimeType',  a->>'mimeType',
      'sizeBytes', (a->>'sizeBytes')::int
    )) FROM jsonb_array_elements(attachments) a),
    '[]'::jsonb
  ) AS attachments,
  estimated_resolution,
  created_at
`;

export interface ListFilters {
  module?: string;
  client?: string;
  environment?: string;
  fromDate?: string;     // ISO o YYYY-MM-DD
  toDate?: string;
  hasAttachments?: boolean;
  search?: string;       // ILIKE en message
  limit?: number;        // default 50, max 200
}

// Tipo extendido del row para captar también la columna estimated_resolution.
interface IncidentRowWithEst extends IncidentRowRaw {
  estimated_resolution?: TicketEstimatedResolution | null;
}

export async function listIncidents(tenantId: string, filters: ListFilters = {}): Promise<IncidentWithEstimate[]> {
  await ensureEstimateSchema(); // asegura columna existe para SELECT
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  function add(cond: string, val: unknown) {
    params.push(val);
    where.push(cond.replace("$?", `$${params.length}`));
  }
  if (filters.module)      add("sap_module = $?", filters.module);
  if (filters.client)      add("client_name = $?", filters.client);
  if (filters.environment) add("environment = $?", filters.environment);
  if (filters.fromDate)    add("created_at >= $?::timestamptz", filters.fromDate);
  if (filters.toDate)      add("created_at <= $?::timestamptz", filters.toDate);
  if (filters.hasAttachments !== undefined) {
    if (filters.hasAttachments) where.push("jsonb_array_length(attachments) > 0");
    else where.push("jsonb_array_length(attachments) = 0");
  }
  if (filters.search) add("message ILIKE $?", `%${filters.search}%`);

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  params.push(limit);

  const whereSql = `WHERE ${where.join(" AND ")}`;
  const { rows } = await query<IncidentRowWithEst>(
    `SELECT ${LIST_SELECT}
       FROM incidents
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params
  );

  // Backfill lazy: filas viejas sin estimación reciben una recién calculada.
  const out: IncidentWithEstimate[] = [];
  for (const row of rows) {
    const base = rowToRecord(row);
    let est: TicketEstimatedResolution | null = row.estimated_resolution ?? null;
    if (!est) {
      est = await enrichIncidentLazy({
        id: row.id,
        message: row.message,
        sap_module: row.sap_module ?? null,
        environment: row.environment ?? null,
        confidence: (row.confidence ?? null) as string | null,
        attachments: row.attachments,
      });
    }
    out.push({ ...base, estimatedResolution: est });
  }
  return out;
}

export async function getIncidentById(tenantId: string, id: string): Promise<IncidentWithEstimate | null> {
  await ensureEstimateSchema();
  // En el detalle SI devolvemos el base64 completo.
  const { rows } = await query<IncidentRowWithEst>(
    `SELECT id, user_name, client_name, sap_module, environment, message, response,
            confidence, model, attachments, estimated_resolution, created_at
       FROM incidents
       WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  const row = rows[0];
  if (!row) return null;
  // En detalle, attachments puede traer dataBase64; lo dejamos pasar como esta.
  const att = Array.isArray(row.attachments) ? (row.attachments as unknown[]) : [];
  const base: IncidentRecord = {
    ...row,
    attachments: att.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        name: typeof o.name === "string" ? o.name : "adjunto",
        mimeType: typeof o.mimeType === "string" ? o.mimeType : "application/octet-stream",
        sizeBytes: typeof o.sizeBytes === "number" ? o.sizeBytes : 0,
        ...(typeof o.dataBase64 === "string" ? { dataBase64: o.dataBase64 } : {}),
      };
    }) as IncidentRecord["attachments"],
  };
  let est: TicketEstimatedResolution | null = row.estimated_resolution ?? null;
  if (!est) {
    est = await enrichIncidentLazy({
      id: row.id,
      message: row.message,
      sap_module: row.sap_module ?? null,
      environment: row.environment ?? null,
      confidence: (row.confidence ?? null) as string | null,
      attachments: row.attachments,
    });
  }
  return { ...base, estimatedResolution: est };
}
