// =============================================================================
// RBAC backend types — espejados del frontend (platform/src/types/rbac.ts).
// =============================================================================
// IMPORTANTE: mantener sincronizado con el RBAC frontend. Cambios aquí deben
// reflejarse allá (y viceversa). El backend usa la MISMA matriz de permisos
// para garantizar enforcement coherente en ambos lados.
// =============================================================================

export type PermissionAction =
  | "view"
  | "create"
  | "edit"
  | "delete"
  | "export"
  | "configure"
  | "approve";

export type PlatformScreen =
  | "dashboard"
  | "agente_ams"
  | "incidentes"
  | "modulos_sap"
  | "servicios"
  | "reportes"
  | "auditoria"
  | "administracion"
  | "configuracion"
  | "canal_telefonico"
  | "conocimiento_rag"
  | "integraciones"
  | "usuarios"
  | "roles"
  | "entrenamiento_ia"
  | "playbooks_ams"
  | "document_factory"
  | "quality_evaluator"
  | "escalamiento_n2"
  | "testing_intelligence"
  | "time_estimator"
  | "ticket_command_center"
  | "audit_trail"
  | "global_search"
  | "agent_readiness"
  | "business_value_dashboard";

export const ALL_SCREENS: PlatformScreen[] = [
  "dashboard", "agente_ams", "incidentes", "modulos_sap", "servicios",
  "reportes", "auditoria", "administracion", "configuracion",
  "canal_telefonico", "conocimiento_rag", "integraciones", "usuarios",
  "roles", "entrenamiento_ia", "playbooks_ams", "document_factory",
  "quality_evaluator", "escalamiento_n2", "testing_intelligence",
  "time_estimator", "ticket_command_center", "audit_trail", "global_search",
  "agent_readiness", "business_value_dashboard",
];

export interface RolePermission {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  export: boolean;
  configure: boolean;
  approve: boolean;
}

export type RolePermissionMap = Record<PlatformScreen, RolePermission>;

/** RoleCode RBAC. Espejado del frontend. */
export type RoleCode =
  | "ADMIN"
  | "SERVICE_LEAD"
  | "AMS_CONSULTANT"
  | "CLIENT_USER"
  | "GENERAL_USER";
