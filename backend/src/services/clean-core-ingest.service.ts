// Clean Core → Organizational Memory + Knowledge Graph (ROCCO — Fase 2).
//
// Recibe hallazgos del connector Clean Core (contrato de push, API-First entre
// servicios) y los convierte en:
//   - nodos SAP-técnicos del grafo (sap_object, sap_table) + aristas (accesses),
//   - MemoryRecords (kind=assessment) con EvidenceUnit anclada al evidence_hash
//     del connector (Evidence by Design, Art. 4).
//
// No inventa: sólo ingiere lo que el connector envía (findings=[] → nada).
// Idempotente por dedupe_key (clean_core_finding:<id>) y por (tenant,id) del grafo.
import { createHash } from "crypto";
import { logger } from "../utils/logger";
import { upsertKgNodes, type GraphNode, type GraphEdge } from "./graph.service";
import { recordMemory } from "./memory.service";

/** Subconjunto del FindingOut del connector (lo mínimo trazable). */
export interface CleanCoreFindingInput {
  id: string;
  object_name: string;
  object_type: string;
  sap_table?: string | null;
  dimension?: string | null;
  severity: string;
  rule_id: string;
  clean_core_route?: string | null;
  operation?: string | null;
  evidence?: string | null;
  evidence_hash?: string | null;
  reference?: string | null;
}

export interface IngestCleanCoreInput {
  systemSid?: string;
  findings: CleanCoreFindingInput[];
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const up = (s: string | null | undefined): string => (s ?? "").trim().toUpperCase();

export async function ingestCleanCoreFindings(
  tenantId: string, input: IngestCleanCoreInput,
): Promise<{ ingested: number; created: number; updated: number; nodes: number; edges: number }> {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const sid = input.systemSid ? up(input.systemSid) : "SAP";

  const nodeMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let created = 0;
  let updated = 0;

  for (const f of findings) {
    if (!f.id || !f.object_name) continue;   // sin identidad no es trazable → se ignora

    const objId = `sap:${sid}:${up(f.object_type) || "OBJ"}:${up(f.object_name)}`;
    nodeMap.set(objId, {
      id: objId,
      type: "sap_object",
      label: f.object_name,
      subtitle: [f.object_type, f.severity].filter(Boolean).join(" · "),
      meta: {
        severity: f.severity, rule: f.rule_id, dimension: f.dimension ?? null,
        route: f.clean_core_route ?? null, system: sid,
      },
    });
    const nodeRefs = [objId];

    if (f.sap_table) {
      const tblId = `sap:${sid}:TABLE:${up(f.sap_table)}`;
      nodeMap.set(tblId, {
        id: tblId, type: "sap_table", label: f.sap_table,
        subtitle: `tabla estándar · ${sid}`, meta: { system: sid },
      });
      edges.push({ from: objId, to: tblId, kind: "accesses" });
      nodeRefs.push(tblId);
    }

    // Evidencia: el evidence_hash del connector ES la evidencia (reproducible).
    const evidence = [{
      source: "sap_connector",
      ref: f.id,
      hash: f.evidence_hash ?? sha256(`${f.id}|${f.rule_id}|${f.object_name}`),
    }];

    const r = await recordMemory({
      tenantId,
      kind: "assessment",
      title: `${f.object_name} · ${f.rule_id}`.slice(0, 200),
      body: [f.evidence, f.clean_core_route ? `Ruta Clean Core: ${f.clean_core_route}` : null,
             f.reference ? `Ref: ${f.reference}` : null].filter(Boolean).join("\n"),
      nodeRefs,
      evidence,
      confidence: "evidence",
      provenance: {
        origin: "system", source: "ingest.clean_core", at: new Date().toISOString(),
        system: sid, severity: f.severity, rule: f.rule_id,
      },
      dedupeKey: `clean_core_finding:${f.id}`,
    });
    if (r.created) created++; else updated++;
  }

  const result = await upsertKgNodes(tenantId, [...nodeMap.values()], edges, "sap_connector");
  logger.info(
    { tenantId, ingested: findings.length, created, updated, nodes: result.nodes, edges: result.edges },
    "memory.ingest.clean_core"
  );
  return { ingested: findings.length, created, updated, nodes: result.nodes, edges: result.edges };
}
