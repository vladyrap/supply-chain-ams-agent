import { query } from "../database/db";
import { upsertSearchFireAndForget } from "./search.service";
import type {
  IncidentRecord,
  AmsChatInputNormalized,
  ConfidenceLevel,
  Attachment,
} from "../types/ams.types";

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

export async function saveIncident(data: SaveIncidentInput): Promise<IncidentRecord> {
  const { input, response, confidence, model } = data;
  const { rows } = await query<IncidentRowRaw>(
    `INSERT INTO incidents
       (user_name, client_name, sap_module, environment, message, response,
        confidence, model, attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id, user_name, client_name, sap_module, environment, message, response,
               confidence, model, attachments, created_at`,
    [
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
  // Indexar en búsqueda semántica (no bloqueante)
  upsertSearchFireAndForget({
    source_type: "incident",
    source_id: rec.id,
    title: rec.message.slice(0, 120),
    excerpt: (rec.response ?? "").slice(0, 800),
    href: "/history",
    metadata: { module: rec.sap_module, client: rec.client_name, confidence: rec.confidence },
  });
  return rec;
}

// Para los listados NO devolvemos el base64 (puede pesar varios MB).
// Devolvemos solo metadata: nombre, mimeType, sizeBytes.
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

export async function listIncidents(filters: ListFilters = {}): Promise<IncidentRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];
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

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await query<IncidentRowRaw>(
    `SELECT ${LIST_SELECT}
       FROM incidents
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return rows.map(rowToRecord);
}

export async function getIncidentById(id: string): Promise<IncidentRecord | null> {
  // En el detalle SI devolvemos el base64 completo.
  const { rows } = await query<IncidentRowRaw>(
    `SELECT id, user_name, client_name, sap_module, environment, message, response,
            confidence, model, attachments, created_at
       FROM incidents
       WHERE id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  // En detalle, attachments puede traer dataBase64; lo dejamos pasar como esta.
  const att = Array.isArray(row.attachments) ? (row.attachments as unknown[]) : [];
  return {
    ...row,
    attachments: att.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        name: typeof o.name === "string" ? o.name : "adjunto",
        mimeType: typeof o.mimeType === "string" ? o.mimeType : "application/octet-stream",
        sizeBytes: typeof o.sizeBytes === "number" ? o.sizeBytes : 0,
        // dataBase64 lo agregamos como propiedad extra; el type IncidentAttachmentMeta
        // no lo declara, pero JSON.stringify lo serializa igual cuando el cliente pide /api/ams/incidents/:id
        ...(typeof o.dataBase64 === "string" ? { dataBase64: o.dataBase64 } : {}),
      };
    }) as IncidentRecord["attachments"],
  };
}
