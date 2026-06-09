// Corpus expandido de conocimiento AMS Supply Chain SAP para alimentar
// al agente con contenido real y diverso. Cargable via endpoint
// POST /api/training/seed/expand (idempotente por title).
//
// Total: 26 knowledge items con summary/content de calidad +
//        Q&A representativas que pueden auto-aprobarse para few-shot.

import * as training from "./training.service";
import { query } from "../database/db";
import { logger } from "../utils/logger";
import type { KnowledgeType, Priority, KnowledgeStatus } from "../types/training.types";

interface CorpusItem {
  title: string;
  content: string;
  summary: string;
  module: string;
  process: string;
  type: KnowledgeType;
  source: string;
  tags: string[];
  priority: Priority;
  status: KnowledgeStatus;
  score?: number;
  qas?: { question: string; expectedAnswer: string }[];
}

const NOW_AUTHOR = "Corpus AMS";

const CORPUS: CorpusItem[] = [
  // ==================== MM · COMPRAS (5) ====================
  {
    title: "MM · ME21N error 'periodo contable no abierto'",
    summary: "Al crear OC en ME21N aparece mensaje M8-077 / FAGL. Revisar período abierto en OB52 y rango de fecha de la OC.",
    content: "## Síntoma\n`No se ha abierto el período X 2026` al guardar OC en ME21N.\n\n## Diagnóstico\n1. OB52 → verificar variante de período de la sociedad.\n2. Revisar fecha de documento de la OC (campo BEDAT).\n3. Confirmar con FI que el período está abierto para cuenta de compras.\n\n## Solución\n- Si el período cerró: cambiar fecha de la OC a período abierto o pedir a FI abrir período en OB52.\n- Si es traspaso de año: revisar variantes anuales (OBA7).",
    module: "MM", process: "Compras", type: "KNOWN_ERROR",
    source: "manual AMS", tags: ["ME21N", "OB52", "periodo", "M8-077"],
    priority: "high", status: "PUBLISHED", score: 92,
    qas: [
      { question: "ME21N me dice que el período no está abierto, ¿qué hago?",
        expectedAnswer: "Revisar OB52 para ver la variante de período de la sociedad. Confirmar la fecha de documento (BEDAT) y pedir a FI abrir el período si corresponde. En traspasos de año verificar variantes anuales en OBA7." },
      { question: "¿En qué transacción reviso si el período contable está abierto para MM?",
        expectedAnswer: "OB52 muestra los períodos abiertos por variante de período y rango de cuenta. Para MM la cuenta tipo es 'M' o el rango de cuenta de compras según el plan de cuentas." },
    ],
  },
  {
    title: "MM · Estrategia de liberación de OC bloquea con error de jerarquía",
    summary: "Estrategia de liberación de ME21N falla. Revisar CL30N clasificación + OMGS jerarquía.",
    content: "## Diagnóstico\n1. ME23N → ver estrategia y código asignados.\n2. CL30N → confirmar valores de característica de la OC.\n3. OMGS / SPRO → grupo y código de liberación.\n4. SU01 → role/perfil del aprobador.\n\n## Workaround\nLiberar manualmente con ME29N si la urgencia lo justifica y registrar excepción.",
    module: "MM", process: "Compras", type: "AMS_PROCEDURE",
    source: "manual AMS", tags: ["ME29N", "estrategia", "liberación", "CL30N"],
    priority: "medium", status: "PUBLISHED", score: 88,
    qas: [
      { question: "La estrategia de liberación de OC no avanza al siguiente paso",
        expectedAnswer: "Revisar CL30N para confirmar que los valores de característica de la OC coinciden con los del grupo de liberación. Validar OMGS para grupo/código y los roles del aprobador en SU01." },
    ],
  },
  {
    title: "MM · Diferencia de cantidad entre OC y entrada de mercancía",
    summary: "MIGO permite cantidad distinta a OC. Revisar tolerancias en OMR6 y campo 'cantidad final' en posición de OC.",
    content: "## Causa típica\nCantidad final marcada en EKPO-EREKZ o tolerancia infinita en OMR6.\n\n## Pasos\n1. ME23N → posición → tab 'Confirmaciones' verificar cantidad final.\n2. OMR6 → tolerancias del grupo de compras.\n3. Si está fuera de tolerancia, MIGO genera bloqueo de factura tipo M.",
    module: "MM", process: "Compras", type: "FUNCTIONAL_STEP",
    source: "incidente recurrente", tags: ["MIGO", "OMR6", "tolerancia", "cantidad"],
    priority: "medium", status: "PUBLISHED", score: 85,
    qas: [
      { question: "¿Por qué MIGO me deja recibir más cantidad de la que tiene la OC?",
        expectedAnswer: "Revisar la tolerancia en OMR6 para el grupo de compras. Si la tolerancia es 'infinito' o muy alta, MIGO permite sobrerrecibir. Validar también si en ME23N la posición tiene cantidad final marcada (EKPO-EREKZ)." },
    ],
  },
  {
    title: "MM · MIRO bloqueado por diferencia de precio M8 081",
    summary: "Factura bloqueada por diferencia de precio. Liberar con MRBR o ajustar tolerancia en OMR6.",
    content: "## Mensaje\n`M8 081: Diferencia de precio mayor a tolerancia`\n\n## Pasos\n1. MIR4 → revisar la factura y la diferencia exacta.\n2. OMR6 → tolerancia del proveedor.\n3. MRBR → liberación de facturas bloqueadas (autorización requerida).\n4. Si la diferencia es legítima, ajustar el precio en la OC con ME22N.",
    module: "MM", process: "Compras", type: "KNOWN_ERROR",
    source: "manual AMS", tags: ["MIRO", "MRBR", "M8-081", "precio"],
    priority: "high", status: "PUBLISHED", score: 90,
    qas: [
      { question: "Factura bloqueada por diferencia de precio en MIRO, ¿cómo libero?",
        expectedAnswer: "Validar la diferencia con MIR4. Si está fuera de tolerancia configurada en OMR6, liberar con MRBR (requiere autorización). Si la diferencia es real y aceptada, corregir el precio de la OC con ME22N y volver a registrar." },
    ],
  },
  {
    title: "MM · Solicitud de pedido no se convierte en OC automáticamente",
    summary: "El conversor automático no genera OC. Revisar registro info y fuente de aprovisionamiento.",
    content: "## Diagnóstico\n1. ME53N → revisar solicitud y fuente.\n2. ME01 / ME0M → registro info y lista de fuentes.\n3. SM37 → job RM06BB30 o conversor batch.\n4. Permisos: M_BANF_BSA, M_BEST_BSA en SU01.",
    module: "MM", process: "Compras", type: "AMS_PROCEDURE",
    source: "manual AMS", tags: ["ME53N", "ME01", "solicitud", "conversor"],
    priority: "medium", status: "VALIDATED", score: 82,
  },

  // ==================== SD · VENTAS (4) ====================
  {
    title: "SD · Pedido cliente no graba por crédito",
    summary: "VA01 bloqueado por límite de crédito. Liberar con VKM3 o revisar FD32.",
    content: "## Mensaje\n`Estado de crédito: documento bloqueado`\n\n## Pasos\n1. FD32 → revisar límite y consumo del cliente.\n2. OVA8 → grupo de riesgo y reglas.\n3. VKM3 → liberación manual del documento bloqueado.\n4. Si el cliente está en mora, derivar a cobranzas.",
    module: "SD", process: "Ventas", type: "KNOWN_ERROR",
    source: "manual AMS", tags: ["VA01", "VKM3", "crédito", "FD32"],
    priority: "high", status: "PUBLISHED", score: 91,
    qas: [
      { question: "VA01 no me deja crear el pedido por crédito, ¿cómo procedo?",
        expectedAnswer: "Revisar el límite y consumo en FD32. Validar grupo de riesgo en OVA8. Liberar el documento manualmente con VKM3 si está autorizado. Si el cliente tiene morosidad, derivar a cobranzas antes de liberar." },
    ],
  },
  {
    title: "SD · Entrega VL01N no graba sin stock disponible",
    summary: "VL01N falla por falta de stock. Verificar MMBE, MD04 y disponibilidad ATP.",
    content: "## Pasos\n1. MMBE → stock por centro/almacén.\n2. MD04 → lista de necesidades.\n3. CO09 → consulta de disponibilidad ATP.\n4. Si hay stock pero no asignable: revisar regla de chequeo de disponibilidad (OVZ7).\n5. Crear orden de transporte si el stock está en otro centro.",
    module: "SD", process: "Ventas", type: "FUNCTIONAL_STEP",
    source: "manual AMS", tags: ["VL01N", "MMBE", "MD04", "ATP", "stock"],
    priority: "medium", status: "PUBLISHED", score: 86,
    qas: [
      { question: "VL01N me dice que no hay stock pero MMBE muestra stock disponible",
        expectedAnswer: "Verificar la regla de chequeo de disponibilidad en OVZ7 — puede que ATP esté reservando el stock para otros documentos. Confirmar con CO09 cuánto stock está realmente disponible para ese centro y fecha. Si hace falta, hacer transporte de stock con MB1B o liberar reservas." },
    ],
  },
  {
    title: "SD · Factura electrónica no se envía a SII (Chile)",
    summary: "Factura SAP no llega a SII. Revisar IDoc INVOIC, status SXMB_MONI y configuración portal.",
    content: "## Pasos\n1. VF02 → comprobar que la factura está contabilizada.\n2. WE02 → IDoc INVOIC, status 03 (enviado) o 51 (error).\n3. SXMB_MONI → mensajes PI/PO.\n4. Portal del proveedor de DTE → estado del archivo XML.\n5. SE91 → mensaje de error específico del IDoc.",
    module: "SD", process: "Ventas", type: "KNOWN_ERROR",
    source: "incidente recurrente", tags: ["VF02", "IDoc", "SII", "factura electrónica"],
    priority: "high", status: "PUBLISHED", score: 89,
    qas: [
      { question: "La factura no llega al SII, ¿qué reviso?",
        expectedAnswer: "Empezar por VF02 para confirmar que la factura está contabilizada. Revisar WE02 buscando el IDoc INVOIC asociado y su status (03 = enviado, 51 = error). Si llegó a status 03, validar SXMB_MONI para PI/PO. Si nunca salió, revisar el portal del DTE para el XML." },
    ],
  },
  {
    title: "SD · Modificar precio en pedido ya facturado",
    summary: "No se puede modificar precio si el pedido tiene factura. Crear nota de crédito o débito según el caso.",
    content: "## Reglas\n- Si la diferencia es a favor del cliente: nota de crédito con FB75 / VA01 tipo G2.\n- Si la diferencia es a favor de la empresa: nota de débito tipo L2.\n- No se debe modificar el pedido original — se referencia desde la nueva nota.\n\n## Pasos\n1. VA01 → tipo G2/L2.\n2. Referenciar la factura original (VBRK).\n3. Ajustar el precio en la posición.\n4. Liberar y facturar con VF01.",
    module: "SD", process: "Ventas", type: "AMS_PROCEDURE",
    source: "manual AMS", tags: ["VA01", "G2", "L2", "nota de crédito"],
    priority: "medium", status: "VALIDATED", score: 84,
  },

  // ==================== PP · PRODUCCIÓN (3) ====================
  {
    title: "PP · CO11N no confirma operación por falta de componente",
    summary: "Confirmación de operación falla por componente sin stock. Revisar MD04 + MIGO 261 si el material existe.",
    content: "## Pasos\n1. CO03 → revisar componentes de la orden de producción.\n2. MMBE → stock del componente faltante.\n3. MD04 → órdenes de aprovisionamiento.\n4. Si hay stock: MIGO movimiento 261 manual contra la orden.\n5. Si falta stock: liberar OC pendiente o cambiar al sustituto en CO02.",
    module: "PP", process: "Producción", type: "INCIDENT_SOLUTION",
    source: "manual AMS", tags: ["CO11N", "CO03", "MIGO 261", "componente"],
    priority: "high", status: "PUBLISHED", score: 87,
    qas: [
      { question: "No puedo confirmar la operación porque dice que falta un componente",
        expectedAnswer: "Validar CO03 para ver los componentes requeridos. Confirmar stock en MMBE. Si hay stock pero no está asignado a la orden, hacer movimiento 261 manual desde MIGO contra el número de orden. Si no hay stock, liberar la OC pendiente o usar sustituto en CO02." },
    ],
  },
  {
    title: "PP · Capacidad sobrecargada en centro de trabajo",
    summary: "CM01/CM07 muestra capacidad >100%. Re-planificar o aumentar disponibilidad temporal.",
    content: "## Diagnóstico\n1. CM01 → carga por centro de trabajo.\n2. CM07 → planificación gráfica.\n3. CR02 → datos básicos del centro y fórmulas de capacidad.\n4. Decisión: re-secuenciar órdenes con CM21 o aumentar capacidad temporal en CR02.",
    module: "PP", process: "Producción", type: "FUNCTIONAL_STEP",
    source: "manual AMS", tags: ["CM01", "CM07", "capacidad", "CR02"],
    priority: "medium", status: "PUBLISHED", score: 83,
  },
  {
    title: "PP · Lista de materiales (BOM) inactiva en producción",
    summary: "Orden de producción no toma la BOM nueva. Revisar status en CS03 + fecha de validez.",
    content: "## Pasos\n1. CS03 → revisar BOM y fecha 'válido desde'.\n2. Status: debe estar liberado para uso 1 (producción).\n3. Si la BOM nueva existe pero no se toma: las órdenes existentes mantienen la BOM original. Solo nuevas órdenes la usan.\n4. CO02 → modificar componentes manualmente para órdenes ya creadas.",
    module: "PP", process: "Producción", type: "KNOWN_ERROR",
    source: "manual AMS", tags: ["CS03", "BOM", "validez"],
    priority: "medium", status: "VALIDATED", score: 81,
  },

  // ==================== FI · FINANZAS (3) ====================
  {
    title: "FI · Cuenta del mayor bloqueada para contabilización",
    summary: "Mensaje F5 234 al contabilizar. Revisar FS00 status 'bloqueado para contabilizar'.",
    content: "## Pasos\n1. FS00 → cuenta del mayor → tab 'Control de cuenta'.\n2. Validar checkboxes 'Bloqueado para contabilizar' o 'Bloqueado para sociedad GL'.\n3. Si está bloqueado, desbloquear con FS00 cambio (requiere autorización FI).\n4. Documentar el cambio en el log de auditoría.",
    module: "FI", process: "Costos", type: "KNOWN_ERROR",
    source: "manual AMS", tags: ["FS00", "F5-234", "cuenta mayor"],
    priority: "medium", status: "PUBLISHED", score: 88,
    qas: [
      { question: "No puedo contabilizar contra una cuenta del mayor, me da F5 234",
        expectedAnswer: "La cuenta probablemente esté marcada como 'Bloqueada para contabilizar' o 'Bloqueada para sociedad GL' en FS00 tab 'Control de cuenta'. Desbloquearla en FS00 con la autorización FI correspondiente y registrar el cambio." },
    ],
  },
  {
    title: "FI · MIRO no contabiliza por divisa fija",
    summary: "Factura en divisa distinta a la OC falla. Revisar tipo de cambio en OB08 y datos del proveedor.",
    content: "## Pasos\n1. OB08 → tipos de cambio vigentes para el día.\n2. XK03 → divisa del proveedor (tabla LFM1).\n3. Si la OC está en USD y la factura llega en EUR: ajustar manualmente el monto en MIRO o pedir al proveedor reemitir.\n4. OBBS → permitir contabilización con divisa diferente si la política lo permite.",
    module: "FI", process: "Costos", type: "FUNCTIONAL_STEP",
    source: "manual AMS", tags: ["MIRO", "OB08", "divisa", "tipo de cambio"],
    priority: "medium", status: "PUBLISHED", score: 84,
  },
  {
    title: "FI · Cierre de período mensual — checklist AMS",
    summary: "Checklist estándar AMS para cierre FI mensual: F.13 → F.07 → F-32 → OB52.",
    content: "## Día -3\n- F.13 → arrastre de saldos cuentas auxiliares.\n- F.07 → arrastre saldo mayor.\n\n## Día -1\n- F-32 → compensación cuentas deudoras.\n- F-44 → compensación acreedores.\n- F-03 → compensación general.\n\n## Día del cierre\n- OB52 → cerrar período del mes en curso.\n- Validar reportes FBL3N (mayor) y S_ALR_87012282.\n\n## Post-cierre\n- Comunicar a stakeholders.\n- Archivar reportes en sharepoint AMS.",
    module: "FI", process: "Costos", type: "AMS_PROCEDURE",
    source: "framework AMS", tags: ["F.13", "F.07", "OB52", "cierre"],
    priority: "high", status: "PUBLISHED", score: 95,
    qas: [
      { question: "¿Cuál es el procedimiento de cierre mensual FI?",
        expectedAnswer: "Día -3: F.13 y F.07 para arrastres. Día -1: F-32 / F-44 / F-03 para compensaciones. Día del cierre: OB52 para cerrar período + validar FBL3N y S_ALR_87012282. Archivar reportes y comunicar a stakeholders." },
    ],
  },

  // ==================== EWM · ALMACÉN (3) ====================
  {
    title: "EWM · WT no se confirma desde RF",
    summary: "Warehouse Task aparece liberada pero RF no la confirma. Revisar /SCWM/MON cola del recurso.",
    content: "## Diagnóstico\n1. /SCWM/PRDO → identificar la WT.\n2. /SCWM/MON → cola del recurso (workplace).\n3. /SCWM/RF_LOG → log de RF si está activo.\n4. SU01 → permisos del operario para esa cola.\n5. Si todo está bien, reasignar la WT a otro recurso en /SCWM/MON.",
    module: "EWM", process: "Almacén", type: "INCIDENT_SOLUTION",
    source: "manual AMS", tags: ["WT", "RF", "/SCWM/MON", "/SCWM/PRDO"],
    priority: "high", status: "PUBLISHED", score: 86,
    qas: [
      { question: "La tarea de almacén está liberada pero el operario no la ve en su RF",
        expectedAnswer: "Revisar /SCWM/PRDO para confirmar la WT. Validar la cola del recurso en /SCWM/MON. Verificar el log de RF con /SCWM/RF_LOG y los permisos del operario en SU01. Si está todo bien, reasignar manualmente la WT a otro recurso desde /SCWM/MON." },
    ],
  },
  {
    title: "EWM · Inventario cíclico genera diferencia no esperada",
    summary: "Conteo cíclico /SCWM/LICC marca diferencia. Validar reservas pendientes + transit stock.",
    content: "## Pasos\n1. /SCWM/LICC → registro del conteo.\n2. /SCWM/MON → revisar HU en tránsito (status 02).\n3. /SCWM/PRDO → reservas / WT abiertas que no estén procesadas.\n4. Si la diferencia es real: confirmar con supervisor antes de aceptar el conteo.\n5. /SCWM/STOCK → vista detallada por tipo de stock.",
    module: "EWM", process: "Almacén", type: "FUNCTIONAL_STEP",
    source: "manual AMS", tags: ["/SCWM/LICC", "conteo", "diferencia"],
    priority: "medium", status: "PUBLISHED", score: 82,
  },
  {
    title: "EWM · Wave no se libera automáticamente",
    summary: "Wave queda en status creado. Revisar reglas de liberación + permisos en /SCWM/WAVE_DEF.",
    content: "## Diagnóstico\n1. /SCWM/WAVE → status del wave.\n2. /SCWM/WAVE_DEF → regla de liberación (manual vs automática).\n3. Si la regla es automática, validar el job /SCWM/WAVE_RELEASE en SM37.\n4. Liberar manualmente con /SCWM/WAVE si la urgencia lo justifica.",
    module: "EWM", process: "Almacén", type: "KNOWN_ERROR",
    source: "incidente recurrente", tags: ["/SCWM/WAVE", "wave", "liberación"],
    priority: "medium", status: "VALIDATED", score: 80,
  },

  // ==================== QM · CALIDAD (2) ====================
  {
    title: "QM · Decisión de empleo (UD) bloqueada por falta de resultados",
    summary: "QA32 no permite UD sin resultados registrados. Completar QA32 → QE71 → QE51N.",
    content: "## Pasos\n1. QA32 → lote de inspección.\n2. QE71 / QE51N → registrar resultados de las características.\n3. Si la característica es física: validar instrumentos de medición vigentes.\n4. Una vez todos los resultados están: QA11 → tomar UD.\n5. Stock pasa a calidad libre o rechazo según la UD.",
    module: "QM", process: "Calidad", type: "FUNCTIONAL_STEP",
    source: "manual AMS", tags: ["QA32", "QA11", "QE51N", "UD"],
    priority: "high", status: "PUBLISHED", score: 89,
    qas: [
      { question: "El stock está en calidad y no puedo tomar la decisión de empleo",
        expectedAnswer: "QA32 requiere todos los resultados registrados antes de la UD. Completar las características con QE71 o QE51N. Validar que los instrumentos de medición estén vigentes. Una vez registrados todos los resultados, tomar la UD con QA11." },
    ],
  },
  {
    title: "QM · Plan de inspección no se asigna al lote",
    summary: "Lote sin plan vigente. Revisar QP02 status + asignación al material en MM02 vista QM.",
    content: "## Pasos\n1. QP02 → plan de inspección → status (debe ser 4 = liberado).\n2. MM02 → vista QM → confirmar tipo de inspección activo.\n3. QA08 → asignación masiva si hay muchos materiales.\n4. Si el plan es nuevo: validar fecha 'válido desde'.",
    module: "QM", process: "Calidad", type: "AMS_PROCEDURE",
    source: "manual AMS", tags: ["QP02", "plan inspección", "MM02"],
    priority: "medium", status: "VALIDATED", score: 81,
  },

  // ==================== BTP / INTEGRACIONES (3) ====================
  {
    title: "BTP · Destination SAP_S4_OData falla con 401",
    summary: "Destination en BTP devuelve 401. Validar credenciales + Communication User en S/4HANA.",
    content: "## Pasos\n1. BTP cockpit → destination → 'Check Connection'.\n2. SU01 (S/4) → usuario de comunicación, password no expirado.\n3. SAP gateway → trazas SMICM si llegan requests.\n4. SOAMANAGER (S/4) → revisar el servicio expuesto.\n5. STRUST → certificados si la conexión es mTLS.",
    module: "BTP", process: "Integraciones", type: "KNOWN_ERROR",
    source: "incidente recurrente", tags: ["BTP", "OData", "401", "destination"],
    priority: "high", status: "PUBLISHED", score: 90,
    qas: [
      { question: "Mi destination en BTP da 401 al llamar OData",
        expectedAnswer: "Verificar 'Check Connection' en el destination. Validar en SU01 que el Communication User no esté bloqueado ni con password expirado. Revisar SMICM en S/4 para ver si llegan los requests. Validar el servicio en SOAMANAGER y certificados en STRUST si aplica mTLS." },
    ],
  },
  {
    title: "Integraciones · IDoc en status 51 con error de partner",
    summary: "IDoc no procesa porque el partner no existe o está inactivo. Revisar WE20 + EDIPAR.",
    content: "## Pasos\n1. WE02 → IDoc en status 51 → mensaje de error.\n2. WE20 → perfil del partner (LS para sistemas, KU para clientes).\n3. Si el partner no existe: crearlo en WE20 según tipo.\n4. Confirmar el message type del IDoc en WE60.\n5. Reprocesar con WE19 o BD87.",
    module: "AMS", process: "Integraciones", type: "INCIDENT_SOLUTION",
    source: "manual AMS", tags: ["IDoc", "WE20", "WE19", "partner"],
    priority: "high", status: "PUBLISHED", score: 88,
    qas: [
      { question: "Un IDoc quedó en status 51 con error de partner",
        expectedAnswer: "Identificar el partner en WE02. Validar su existencia en WE20 con el tipo correcto (LS para sistemas lógicos, KU para clientes, LI para proveedores). Si no existe, crearlo. Confirmar el message type con WE60 y reprocesar con WE19 o masivo con BD87." },
    ],
  },
  {
    title: "Integraciones · Webhook saliente AMS no llega al endpoint",
    summary: "Webhook no se entrega. Validar tabla de logs + HMAC + retry policy.",
    content: "## Pasos\n1. Tabla outgoing_webhooks → status y last_attempt_at.\n2. Validar URL del destino con curl desde el host del backend.\n3. Verificar HMAC signature en headers (X-AMS-Signature).\n4. Si el endpoint devuelve 5xx, el sistema reintenta. Si devuelve 4xx, queda en estado FAILED.\n5. Reintentar manualmente desde el panel de integraciones.",
    module: "AMS", process: "Integraciones", type: "AMS_PROCEDURE",
    source: "manual AMS", tags: ["webhook", "HMAC", "retry"],
    priority: "medium", status: "VALIDATED", score: 78,
  },

  // ==================== AMS GENÉRICO (3) ====================
  {
    title: "AMS · Protocolo de escalamiento Nivel 1 → Nivel 2",
    summary: "Cuándo y cómo escalar un ticket de N1 a N2. Triggers + plantilla.",
    content: "## Triggers automáticos\n- SLA crítica (>75% del tiempo consumido)\n- Cliente VIP marcado en config\n- 2 reintentos sin solución\n- Petición explícita del cliente\n\n## Plantilla de escalamiento\n```\nTicket: MESA-XXXX\nMódulo: [MM/SD/...]\nSíntoma: [breve]\nReproducción: [pasos]\nLogs/transacciones revisadas: [...]\nWorkaround aplicado: [...]\nHipótesis: [si la tenemos]\nUrgencia: [con justificación]\n```\n\n## Roles N2\n- Funcional senior\n- Técnico ABAP\n- Líder de servicio si es crítico.",
    module: "AMS", process: "AMS Genérico", type: "AMS_PROCEDURE",
    source: "framework AMS", tags: ["escalamiento", "N2", "SLA"],
    priority: "critical", status: "PUBLISHED", score: 96,
    qas: [
      { question: "¿Cuándo debo escalar un ticket a Nivel 2?",
        expectedAnswer: "Escalá si: la SLA consumida supera 75%, el cliente es VIP, ya hubo 2 reintentos sin éxito, o el cliente lo pide explícitamente. Incluir en el escalamiento: módulo, síntoma, reproducción, transacciones revisadas, workaround aplicado, hipótesis si la tenés y justificación de urgencia." },
    ],
  },
  {
    title: "AMS · Plantilla RCA para incidente crítico (7 secciones)",
    summary: "Plantilla obligatoria AMS para RCA de incidentes críticos. 5 porqués + acciones.",
    content: "# Plantilla RCA AMS\n\n## 1. Resumen ejecutivo (2 líneas)\nQué pasó, impacto, estado actual.\n\n## 2. Línea de tiempo\nHora por hora desde el primer síntoma hasta la mitigación.\n\n## 3. Impacto al negocio\nÁreas afectadas, # usuarios, # transacciones perdidas, $ estimado.\n\n## 4. Causa raíz (5 porqués)\nIr al fondo. No quedarse en el síntoma.\n\n## 5. Acciones correctivas inmediatas\nLo que se hizo para que el sistema vuelva.\n\n## 6. Acciones preventivas\nLo que vamos a hacer para que NO se repita.\n\n## 7. Métricas comprometidas\nFecha objetivo + responsable + KPI a verificar.",
    module: "AMS", process: "AMS Genérico", type: "RCA",
    source: "framework AMS", tags: ["RCA", "plantilla", "crítico", "5 porqués"],
    priority: "critical", status: "PUBLISHED", score: 95,
    qas: [
      { question: "¿Qué secciones lleva un RCA AMS?",
        expectedAnswer: "7 secciones obligatorias: 1) Resumen ejecutivo de 2 líneas. 2) Línea de tiempo hora por hora. 3) Impacto al negocio cuantificado. 4) Causa raíz con 5 porqués. 5) Acciones correctivas inmediatas. 6) Acciones preventivas. 7) Métricas comprometidas con fecha y responsable." },
    ],
  },
  {
    title: "AMS · Validación post-correctivo en producción",
    summary: "Checklist obligatorio antes de cerrar un ticket en PRD. 4 puntos.",
    content: "## Antes de cerrar el ticket\n1. **Reproducir el caso original** y confirmar que ya no falla.\n2. **Validar con el usuario** que reportó el incidente — pedirle confirmación escrita.\n3. **Revisar logs/transacciones** 1h post-corrección para detectar efectos colaterales.\n4. **Documentar la solución** en el ticket: pasos exactos + transacciones tocadas + parches/notas OSS aplicadas.\n\n## Solo entonces se cierra el ticket.",
    module: "AMS", process: "AMS Genérico", type: "AMS_PROCEDURE",
    source: "framework AMS", tags: ["validación", "cierre", "post-mortem"],
    priority: "high", status: "VALIDATED", score: 89,
  },
];

/**
 * Carga el corpus en la DB. Idempotente: si un item con el mismo title ya
 * existe, lo salta. Si el corpus item declara qas, las crea como
 * approved=true asociadas al item.
 */
export async function loadExpandedCorpus(): Promise<{
  itemsCreated: number;
  itemsSkipped: number;
  qasCreated: number;
  publishedCount: number;
}> {
  // MT-2: seed/demo runner sin contexto HTTP, usamos "default". TODO MT-6: parametrizar.
  const tenantId = "default";
  // Asegurar schema
  await training.getSnapshot(tenantId).catch(() => null);

  // Existing titles para deduplicar (scoped al tenant)
  const { rows: existing } = await query<{ title: string }>(
    `SELECT title FROM kb_training_items WHERE tenant_id = $1`,
    [tenantId]
  );
  const existingTitles = new Set(existing.map((r) => r.title));

  let itemsCreated = 0;
  let itemsSkipped = 0;
  let qasCreated = 0;
  let publishedCount = 0;

  for (const item of CORPUS) {
    if (existingTitles.has(item.title)) {
      itemsSkipped++;
      continue;
    }
    try {
      const row = await training.createItem(tenantId, {
        title: item.title, content: item.content, summary: item.summary,
        module: item.module, process: item.process, type: item.type,
        source: item.source, tags: item.tags, priority: item.priority,
        status: item.status, author: NOW_AUTHOR,
      });
      itemsCreated++;
      if (item.status === "PUBLISHED") publishedCount++;
      // Si era PUBLISHED, marcar validación completa + score curado
      if (item.status === "PUBLISHED" || item.status === "VALIDATED") {
        await training.updateItem(tenantId, row.id, {
          validationStage: "FULLY_VALIDATED",
          functionalValidatedBy: "Consultor AMS",
          technicalValidatedBy: "Líder Servicio",
          validatedBy: "Líder Servicio",
          publishedAt: item.status === "PUBLISHED" ? new Date().toISOString() : null,
          score: item.score ?? (item.status === "PUBLISHED" ? 88 : 80),
        });
      }
      // Q&A aprobadas listas para few-shot
      if (item.qas && item.qas.length > 0) {
        const created = await training.createQA(tenantId, item.qas.map((q) => ({
          knowledgeItemId: row.id,
          question: q.question, expectedAnswer: q.expectedAnswer,
        })));
        // marcar todas como aprobadas
        for (const qa of created) {
          await training.updateQA(tenantId, qa.id, { approved: true });
        }
        qasCreated += created.length;
      }
    } catch (err) {
      logger.warn({ err, title: item.title }, "loadExpandedCorpus item fail");
    }
  }

  logger.info({ itemsCreated, itemsSkipped, qasCreated, publishedCount }, "expanded corpus loaded");
  return { itemsCreated, itemsSkipped, qasCreated, publishedCount };
}

export const CORPUS_SIZE = CORPUS.length;
