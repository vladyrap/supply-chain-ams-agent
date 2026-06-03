// =============================================================================
// Matriz de permisos por rol — espejada de
// platform/src/utils/rbac.ts → buildDefaultRoles()
// =============================================================================
// Si la matriz frontend cambia, hay que actualizar esto a mano. Lo idóneo a
// futuro es leer la matriz desde la tabla `platform_roles` (que ya existe vía
// rbac.service.ts). Por ahora usamos defaults hardcodeados para que el
// enforcement funcione aún si la tabla está vacía.
// =============================================================================

import {
  type RoleCode, type RolePermission, type RolePermissionMap, type PlatformScreen,
  ALL_SCREENS,
} from "../types/permissions.types";

function noPerm(): RolePermission {
  return { view: false, create: false, edit: false, delete: false, export: false, configure: false, approve: false };
}
function viewOnly(): RolePermission { return { ...noPerm(), view: true }; }
function viewExport(): RolePermission { return { ...noPerm(), view: true, export: true }; }
function viewCreate(): RolePermission { return { ...noPerm(), view: true, create: true }; }
function viewCreateEdit(): RolePermission { return { ...noPerm(), view: true, create: true, edit: true }; }
function viewExportApprove(): RolePermission { return { ...noPerm(), view: true, export: true, approve: true }; }
function fullPerm(): RolePermission { return { view: true, create: true, edit: true, delete: true, export: true, configure: true, approve: true }; }

function buildMap(spec: Partial<RolePermissionMap>): RolePermissionMap {
  const out = {} as RolePermissionMap;
  for (const s of ALL_SCREENS) out[s] = spec[s] ?? noPerm();
  return out;
}

const PERMISSIONS_BY_ROLE: Record<RoleCode, RolePermissionMap> = {
  ADMIN: buildMap({
    dashboard:        fullPerm(),
    agente_ams:       fullPerm(),
    incidentes:       fullPerm(),
    modulos_sap:      fullPerm(),
    servicios:        fullPerm(),
    reportes:         fullPerm(),
    auditoria:        fullPerm(),
    administracion:   fullPerm(),
    configuracion:    fullPerm(),
    canal_telefonico: fullPerm(),
    conocimiento_rag: fullPerm(),
    integraciones:    fullPerm(),
    usuarios:         fullPerm(),
    roles:            fullPerm(),
    entrenamiento_ia: fullPerm(),
    playbooks_ams:    fullPerm(),
    document_factory: fullPerm(),
    quality_evaluator:fullPerm(),
    escalamiento_n2:  fullPerm(),
    testing_intelligence: fullPerm(),
    time_estimator:   fullPerm(),
    ticket_command_center: fullPerm(),
    audit_trail:      fullPerm(),
    global_search:    fullPerm(),
    agent_readiness:  fullPerm(),
    business_value_dashboard: fullPerm(),
  }),

  SERVICE_LEAD: buildMap({
    dashboard:        viewExportApprove(),
    agente_ams:       viewCreateEdit(),
    incidentes:       { ...viewCreateEdit(), export: true, approve: true },
    modulos_sap:      viewExport(),
    servicios:        { ...viewCreateEdit(), approve: true },
    reportes:         viewExportApprove(),
    auditoria:        viewExport(),
    administracion:   viewOnly(),
    configuracion:    { ...viewOnly(), configure: true },
    canal_telefonico: viewExport(),
    conocimiento_rag: viewCreateEdit(),
    integraciones:    { ...viewCreateEdit(), approve: true },
    usuarios:         viewOnly(),
    roles:            viewOnly(),
    entrenamiento_ia: { ...viewCreateEdit(), export: true, approve: true },
    playbooks_ams:    { ...viewCreateEdit(), export: true, approve: true },
    document_factory: { ...viewCreateEdit(), export: true, approve: true },
    quality_evaluator:{ ...viewCreateEdit(), export: true, approve: true },
    escalamiento_n2:  { ...viewCreateEdit(), export: true, configure: true, approve: true },
    testing_intelligence: { ...viewCreateEdit(), export: true, configure: true, approve: true },
    time_estimator:   { ...viewCreateEdit(), export: true, approve: true },
    ticket_command_center: { ...viewCreateEdit(), export: true, approve: true },
    audit_trail:      viewExport(),
    global_search:    viewOnly(),
    agent_readiness:  viewExport(),
    business_value_dashboard: viewExportApprove(),
  }),

  AMS_CONSULTANT: buildMap({
    dashboard:        viewExport(),
    agente_ams:       viewCreateEdit(),
    incidentes:       viewCreateEdit(),
    modulos_sap:      viewOnly(),
    servicios:        viewCreateEdit(),
    reportes:         viewExport(),
    auditoria:        noPerm(),
    administracion:   noPerm(),
    configuracion:    viewOnly(),
    canal_telefonico: viewOnly(),
    conocimiento_rag: viewCreateEdit(),
    integraciones:    viewOnly(),
    usuarios:         noPerm(),
    roles:            noPerm(),
    entrenamiento_ia: viewCreateEdit(),
    playbooks_ams:    { ...viewCreateEdit(), export: true },
    document_factory: { ...viewCreateEdit(), export: true },
    quality_evaluator:viewCreateEdit(),
    escalamiento_n2:  { ...viewCreateEdit(), export: true },
    testing_intelligence: { ...viewCreateEdit(), export: true },
    time_estimator:   { ...viewCreateEdit(), export: true },
    ticket_command_center: viewCreateEdit(),
    audit_trail:      viewOnly(),
    global_search:    viewOnly(),
    agent_readiness:  viewOnly(),
    business_value_dashboard: viewOnly(),
  }),

  CLIENT_USER: buildMap({
    dashboard:        viewOnly(),
    agente_ams:       viewCreate(),
    incidentes:       viewCreate(),
    modulos_sap:      viewOnly(),
    servicios:        viewOnly(),
    configuracion:    viewOnly(),
    conocimiento_rag: viewOnly(),
    playbooks_ams:    viewOnly(),
    document_factory: viewOnly(),
    escalamiento_n2:  viewOnly(),
    testing_intelligence: viewOnly(),
    time_estimator:   viewOnly(),
    ticket_command_center: viewOnly(),
    global_search:    viewOnly(),
  }),

  GENERAL_USER: buildMap({
    dashboard:        viewOnly(),
    agente_ams:       viewCreate(),
    modulos_sap:      viewOnly(),
    configuracion:    viewOnly(),
    conocimiento_rag: viewOnly(),
    ticket_command_center: viewOnly(),
  }),
};

/** Devuelve la matriz de permisos para un roleCode. Null si no existe. */
export function getPermissionsForRoleCode(code: RoleCode | string): RolePermissionMap | null {
  if (!code) return null;
  return PERMISSIONS_BY_ROLE[code as RoleCode] ?? null;
}

/** Map del Role legacy (viewer/consultor/aprobador/admin) al roleCode RBAC. */
export function legacyRoleToCode(role: string | null | undefined): RoleCode {
  switch ((role || "").toLowerCase()) {
    case "admin":     return "ADMIN";
    case "aprobador": return "SERVICE_LEAD";
    case "consultor": return "AMS_CONSULTANT";
    case "viewer":    return "GENERAL_USER";
    default:          return "GENERAL_USER";
  }
}

/** Devuelve todas las screens que un roleCode puede ver. */
export function getVisibleScreensForRole(code: RoleCode | string): PlatformScreen[] {
  const perms = getPermissionsForRoleCode(code);
  if (!perms) return [];
  return ALL_SCREENS.filter((s) => perms[s]?.view);
}
