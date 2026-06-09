// Seed inicial del Centro de Entrenamiento.
// Si las tablas kb_training_* están vacías al primer arranque del backend,
// poblamos con los mismos 8 items + 4 gaps + 3 versions que el frontend
// usaba como localStorage demo. Idempotente: no duplica si ya hay datos.

import { query } from "../database/db";
import { logger } from "../utils/logger";
import * as training from "./training.service";

export async function seedTrainingIfEmpty(): Promise<void> {
  // MT-2: seed boot sin contexto HTTP, usamos "default". TODO MT-6: per-tenant seed.
  const tenantId = "default";
  try {
    const { rows } = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM kb_training_items WHERE tenant_id = $1`,
      [tenantId]
    );
    if (Number(rows[0]?.c ?? 0) > 0) {
      logger.debug({ count: rows[0]?.c }, "kb_training_items ya tiene datos, skip seed");
      return;
    }
  } catch (err) {
    // tabla aún no existe → llamar a getSnapshot fuerza ensureSchema
    logger.debug({ err }, "kb_training_items ausente, ensureSchema antes de seed");
    await training.getSnapshot(tenantId);
  }

  logger.info("kb_training vacío — sembrando datos demo");

  // ----- 8 knowledge items -----
  const itemsSeed: Array<Parameters<typeof training.createItem>[1]> = [
    {
      title: "MM · Entrada de mercancía no contabiliza contra OC",
      content:
        "## Síntoma\nAl ejecutar MIGO el sistema no permite contabilizar la entrada contra la OC.\n\n" +
        "## Posibles causas\n1. OC sin liberación.\n2. Posición de la OC eliminada.\n3. Proveedor bloqueado.\n4. Tolerancias de cantidad/precio fuera de rango.\n5. Mensaje M7 021 / 022 asociado.\n\n" +
        "## Solución paso a paso\n1. ME23N → verificar estrategia de liberación.\n2. Revisar `EKPO-LOEKZ` por posición eliminada.\n3. XK03 → tab Status verificar bloqueo de pagos/compras.\n4. OMR6 → tolerancias por grupo.\n5. SE91 → resolver mensaje M7 puntual.",
      summary: "MM no permite hacer MIGO contra una OC. Revisar liberación, posición eliminada, proveedor bloqueado, tolerancias y mensajes M7.",
      module: "MM", process: "Compras", type: "INCIDENT_SOLUTION",
      source: "ticket #MESA-1023", tags: ["MIGO", "OC", "M7", "liberación"],
      priority: "high", status: "PUBLISHED", author: "Consultor AMS",
    },
    {
      title: "SD · Pedido de venta no determina precio",
      content:
        "## Mensaje\n`VPRICE 002 — No se pudo determinar precio para condición PR00`.\n\n" +
        "## Verificaciones\n1. V/08 → estrategia de pricing del documento.\n2. VK13 → registro vigente para combinación cliente/material.\n3. V/06 → acceso a condición.\n4. V/04 → grupo de cliente y material.",
      summary: "SD pricing no determina. Revisar V/08 estrategia, VK13 condición, V/06 acceso y V/04 grupos.",
      module: "SD", process: "Ventas", type: "KNOWN_ERROR",
      source: "minuta AMS 2026-05-12", tags: ["pricing", "VA01", "VK13", "PR00"],
      priority: "medium", status: "VALIDATED", author: "Consultor AMS",
    },
    {
      title: "PP · MRP no genera propuestas para material",
      content:
        "## Síntoma\nMD02 / MD03 corre sin errores pero no genera órdenes planificadas.\n\n" +
        "## Diagnóstico AMS\n1. MM03 vista MRP1 → tipo de planificación.\n2. MM03 vista MRP2 → estrategia de planificación.\n3. MD04 → revisar stock y necesidades brutas.\n4. OMI8 → parámetros del grupo MRP.\n5. SM37 → revisar logs del último run.",
      summary: "MRP no genera propuestas. Revisar MM03 MRP1/MRP2, MD04, OMI8 y SM37 del job.",
      module: "PP", process: "Planificación", type: "AMS_PROCEDURE",
      source: "incidente recurrente", tags: ["MD02", "MRP", "MM03"],
      priority: "medium", status: "PENDING_REVIEW", author: "Consultor AMS",
    },
    {
      title: "EWM · Tarea de almacén bloqueada en cola",
      content:
        "## Contexto\nLa tarea de almacén (WT) aparece en estado liberada pero no se confirma por RF.\n\n" +
        "## Pasos\n1. /SCWM/PRDO → identificar nro de WT.\n2. /SCWM/MON → cola del recurso.\n3. Liberar manual si no hay conflicto.",
      summary: "WT bloqueada en EWM. Revisar PRDO, monitor de colas y liberación manual del recurso.",
      module: "EWM", process: "Almacén", type: "FUNCTIONAL_STEP",
      source: "manual", tags: ["WT", "PRDO", "RF"],
      priority: "high", status: "DRAFT", author: "Consultor AMS",
    },
    {
      title: "QM · Lote de inspección sin decisión de empleo",
      content:
        "## Pregunta frecuente\n¿Por qué el material está bloqueado para uso si la inspección está completa?\n\n" +
        "## Respuesta\nFalta UD (Usage Decision). Ejecutar QA32 o QA11 para tomar la decisión y liberar el stock a calidad libre.",
      summary: "Lote QM con stock bloqueado: ejecutar QA32 / QA11 y registrar la UD.",
      module: "QM", process: "Calidad", type: "FAQ",
      source: "FAQ AMS", tags: ["QA32", "UD", "lote"],
      priority: "medium", status: "VALIDATED", author: "Consultor AMS",
    },
    {
      title: "Integraciones · IDoc detenido por error de segmento",
      content:
        "## Mensaje típico\n`EDI: Error de sintaxis en segmento E2EDP01`.\n\n" +
        "## Acciones\n1. WE02 → status 51 / 64.\n2. WE19 → reprocesar manualmente.\n3. WE60 → revisar definición del segmento.\n4. SM58 → cola tRFC.",
      summary: "IDoc detenido por error de segmento: WE02, WE19, WE60 y SM58 para diagnóstico y reproceso.",
      module: "AMS", process: "Integraciones", type: "KNOWN_ERROR",
      source: "incidente recurrente", tags: ["IDoc", "WE02", "EDI"],
      priority: "high", status: "PUBLISHED", author: "Consultor AMS",
    },
    {
      title: "AMS · Plantilla RCA para incidente crítico",
      content:
        "# Plantilla RCA AMS\n\n## 1. Resumen ejecutivo\n## 2. Línea de tiempo\n## 3. Impacto al negocio\n## 4. Causa raíz (5 porqués)\n## 5. Acciones correctivas inmediatas\n## 6. Acciones preventivas\n## 7. Métricas comprometidas",
      summary: "Plantilla RCA estándar AMS para incidentes críticos: 7 secciones obligatorias.",
      module: "AMS", process: "AMS Genérico", type: "RCA",
      source: "framework AMS", tags: ["RCA", "plantilla", "incidente crítico"],
      priority: "critical", status: "PUBLISHED", author: "Líder Servicio",
    },
    {
      title: "BTP · Revisión inicial de fallo en integración OData",
      content:
        "## Checklist\n1. BTP cockpit → status del destination.\n2. SCC4 → confirmar mandante origen.\n3. /IWFND/ERROR_LOG → revisar errores recientes.\n4. STRUST → certificados vigentes.\n5. RZ20 → CCMS de los servicios.",
      summary: "Fallo OData BTP: revisar destination, mandante, error log, certificados y CCMS.",
      module: "BTP", process: "Integraciones", type: "AMS_PROCEDURE",
      source: "manual", tags: ["BTP", "OData", "STRUST"],
      priority: "high", status: "PENDING_REVIEW", author: "Consultor AMS",
    },
  ];

  for (const it of itemsSeed) {
    try {
      const row = await training.createItem(tenantId, it);
      // backfill: si era PUBLISHED, marcar validación completa
      if (it.status === "PUBLISHED" || it.status === "VALIDATED") {
        await training.updateItem(tenantId, row.id, {
          validationStage: "FULLY_VALIDATED",
          functionalValidatedBy: "Consultor AMS",
          technicalValidatedBy: "Líder Servicio",
          validatedBy: "Líder Servicio",
          publishedAt: it.status === "PUBLISHED" ? new Date().toISOString() : null,
          score: it.title.includes("RCA") ? 95
               : it.title.includes("MIGO") ? 92
               : it.title.includes("IDoc") ? 90
               : it.title.includes("pricing") ? 88
               : it.title.includes("Lote") ? 81
               : it.title.includes("BTP") ? 79 : 80,
        });
      }
    } catch (err) {
      logger.warn({ err, title: it.title }, "training.seed item fail");
    }
  }

  // ----- 4 gaps -----
  const gapsSeed = [
    {
      title: "Falta procedimiento para error de forecast en SAP IBP",
      description: "Usuarios reportan errores recurrentes en cargas de forecast IBP y no hay procedimiento documentado.",
      module: "IBP", process: "Planificación", priority: "high" as const,
      suggestedAction: "Cargar procedimiento de diagnóstico para errores de carga en planificación IBP y mapear códigos típicos.",
    },
    {
      title: "Baja cobertura en EWM RF picking",
      description: "Solo hay un knowledge item de EWM y no cubre escenarios RF.",
      module: "EWM", process: "Almacén", priority: "medium" as const,
      suggestedAction: "Crear guías paso a paso para RF picking, transferencias y conteo cíclico desde HU.",
    },
    {
      title: "Sin guía validada para Flexible Workflow en compras",
      description: "El agente no tiene conocimiento aprobado sobre Flexible Workflow para liberación de OC.",
      module: "MM", process: "Compras", priority: "medium" as const,
      suggestedAction: "Documentar configuración SWDD + escenarios de aprobación por monto.",
    },
    {
      title: "Falta RCA para error recurrente de pricing SD",
      description: "Hay 3 incidentes en 30 días por el mismo síntoma SD pricing y no hay RCA.",
      module: "SD", process: "Ventas", priority: "high" as const,
      suggestedAction: "Ejecutar RCA con líder funcional SD y publicar artículo con acciones preventivas.",
    },
  ];
  for (const g of gapsSeed) {
    try { await training.createGap(tenantId, g); }
    catch (err) { logger.warn({ err }, "training.seed gap fail"); }
  }

  // ----- 3 versions -----
  const versionsSeed = [
    {
      version: "v0.1",
      description: "Base inicial AMS — primer corpus de conocimiento del agente.",
      createdBy: "Admin Sistema",
      itemCount: 12, validatedCount: 8, publishedCount: 8,
      changelog: ["Carga inicial de 12 ítems base AMS", "Cobertura MM, SD, AMS genérico"],
    },
    {
      version: "v0.2",
      description: "Conocimiento MM/SD — expansión cobertura procesos críticos.",
      createdBy: "Líder Servicio",
      itemCount: 22, validatedCount: 18, publishedCount: 15,
      changelog: [
        "Añadidos 10 ítems MM y SD",
        "Validación funcional + técnica activada",
        "Score promedio subió de 71 → 84",
      ],
    },
    {
      version: "v0.3",
      description: "Validación AMS premium — incorpora EWM, QM, integraciones, BTP.",
      createdBy: "Líder Servicio",
      itemCount: 8, validatedCount: 5, publishedCount: 3,
      changelog: [
        "Incorpora EWM + QM + IDoc + BTP",
        "Activado modo estricto anti-alucinación",
        "Plantilla RCA crítica publicada",
      ],
    },
  ];
  for (const v of versionsSeed) {
    try { await training.createVersion(tenantId, v); }
    catch (err) { logger.warn({ err }, "training.seed version fail"); }
  }
  // marcar v0.3 como publicada para que el frontend la muestre como activa
  try {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM kb_training_versions WHERE version = 'v0.3' AND tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenantId]
    );
    if (rows[0]) await training.updateVersionStatus(tenantId, rows[0].id, "PUBLISHED");
  } catch (err) {
    logger.warn({ err }, "training.seed publish v0.3 fail");
  }

  logger.info("training.seed completado");
}
