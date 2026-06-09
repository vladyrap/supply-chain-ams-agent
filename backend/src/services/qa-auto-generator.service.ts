// Auto-generador de Q&A para items que no las tienen (multi-tenant).
//
// MT-3: autoGenerateQasForItems recibe tenantId obligatorio y scopea
// el SELECT/INSERT por tenant. El cron passes el tenantId desde el
// worker (uno por tenant activo).
//
// Para cada KnowledgeItem en estado PUBLISHED o VALIDATED que no tenga
// Q&A asociadas (del mismo tenant), genera 3 Q&A usando un algoritmo
// determinístico basado en title/summary/content/tags + módulo. Las
// marca approved=true para que estén disponibles inmediatamente como
// few-shot del agente.

import { query } from "../database/db";
import { logger } from "../utils/logger";
import * as training from "./training.service";

export interface AutoQaReport {
  itemsScanned: number;
  itemsSkipped: number;       // items que ya tenían Q&A
  qasCreated: number;
  qasApproved: number;
  byModule: { module: string; items: number; qas: number }[];
}

interface ItemRow {
  id: string; title: string; summary: string; content: string;
  module: string; tags: string[]; type: string;
}

function buildQasForItem(item: ItemRow): { question: string; expectedAnswer: string }[] {
  const tagsList = item.tags.slice(0, 3).join(", ");
  const cleanTitle = item.title.replace(/^[A-Z]+\s*·\s*/, "").trim();
  const baseAnswer = item.summary || item.content.slice(0, 280);

  // Templates base
  const templates: { question: string; expectedAnswer: string }[] = [
    {
      question: `Tengo un problema relacionado con: ${cleanTitle}. ¿Qué reviso primero?`,
      expectedAnswer: baseAnswer,
    },
    {
      question: `¿Cuáles son los pasos para diagnosticar un caso de ${item.module} - ${cleanTitle.slice(0, 60)}?`,
      expectedAnswer: tagsList
        ? `Revisar las transacciones / tablas clave: ${tagsList}. Luego: ${baseAnswer}`
        : baseAnswer,
    },
    {
      question: `¿Qué transacción SAP debería usar para abordar este caso en ${item.module}?`,
      expectedAnswer: tagsList
        ? `Las transacciones / objetos clave son: ${tagsList}. ${baseAnswer}`
        : baseAnswer,
    },
  ];

  // Si el tipo del item es KNOWN_ERROR, agregar una pregunta de workaround
  if (item.type === "KNOWN_ERROR") {
    templates.push({
      question: `Dame un workaround temporal para este caso de ${item.module}.`,
      expectedAnswer: `Como solución temporal: ${baseAnswer} Documentar el workaround en el ticket y abrir uno paralelo para causa raíz.`,
    });
  }

  return templates.slice(0, 3);
}

export async function autoGenerateQasForItems(
  tenantId: string,
  opts: { limit?: number } = {},
): Promise<AutoQaReport> {
  await training.getSnapshot(tenantId).catch(() => null);
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));

  // Items PUBLISHED/VALIDATED que NO tengan Q&A asociadas (scoped al tenant)
  const { rows: items } = await query<ItemRow>(
    `SELECT i.id, i.title, i.summary, i.content, i.module, i.tags, i.type
       FROM kb_training_items i
      WHERE i.status IN ('PUBLISHED','VALIDATED')
        AND i.tenant_id = $2
        AND NOT EXISTS (SELECT 1 FROM kb_training_qa q WHERE q.knowledge_item_id = i.id AND q.tenant_id = $2)
      ORDER BY i.updated_at DESC
      LIMIT $1`,
    [limit, tenantId]
  );

  const report: AutoQaReport = {
    itemsScanned: items.length,
    itemsSkipped: 0,
    qasCreated: 0,
    qasApproved: 0,
    byModule: [],
  };
  const moduleAcc = new Map<string, { items: number; qas: number }>();

  for (const item of items) {
    const qas = buildQasForItem(item);
    if (qas.length === 0) {
      report.itemsSkipped++;
      continue;
    }
    try {
      const created = await training.createQA(tenantId, qas.map((q) => ({
        knowledgeItemId: item.id,
        question: q.question,
        expectedAnswer: q.expectedAnswer,
      })));
      report.qasCreated += created.length;
      // Aprobar todas
      for (const qa of created) {
        await training.updateQA(tenantId, qa.id, { approved: true });
        report.qasApproved++;
      }
      const cur = moduleAcc.get(item.module) ?? { items: 0, qas: 0 };
      cur.items++;
      cur.qas += created.length;
      moduleAcc.set(item.module, cur);
    } catch (err) {
      logger.warn({ err, itemId: item.id, tenantId }, "autoGenerateQas item fail");
      report.itemsSkipped++;
    }
  }
  report.byModule = Array.from(moduleAcc.entries()).map(([module, v]) => ({ module, items: v.items, qas: v.qas }));
  logger.info({ ...report, tenantId }, "auto-Q&A generation completed");
  return report;
}
