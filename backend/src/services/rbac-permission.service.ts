// =============================================================================
// RBAC Permission Service — la fuente de verdad backend para "¿puede este
// usuario hacer la acción X sobre la screen Y?"
// =============================================================================
// Lookup order:
//   1) Si el roleCode del user existe en la matriz default (5 roles seed),
//      uso esa matriz.
//   2) Si no existe (rol custom creado en /admin), busco en la tabla
//      platform_roles (vía rbac.service.ts) y leo su `permissions` JSONB.
//   3) Si nada matchea → fail-closed (denegado).
//
// El admin del sistema (Role legacy = "admin") SIEMPRE tiene todo permitido,
// para evitar lockout total si la matriz queda mal configurada.
// =============================================================================

import {
  type PlatformScreen, type PermissionAction, type RolePermissionMap,
} from "../types/permissions.types";
import type { User } from "../types/auth.types";
import { getPermissionsForRoleCode, legacyRoleToCode } from "../lib/default-permissions";
import { listGlobalRoles } from "./rbac.service";
import { logger } from "../utils/logger";

/**
 * Decide si un user puede hacer `action` sobre `screen`.
 *
 * @param user  user autenticado (FastifyRequest.user)
 * @param screen pantalla RBAC
 * @param action acción RBAC
 * @returns boolean — fail-closed si null/inactive/no_role
 */
export async function hasPermission(
  user: User | null | undefined,
  screen: PlatformScreen,
  action: PermissionAction,
): Promise<boolean> {
  if (!user || !user.active) return false;

  // Bypass admin: el rol legacy "admin" tiene todo. Esto previene un lockout
  // por matriz mal configurada y refleja la regla "ADMIN puede todo" del spec.
  if (user.role === "admin") return true;

  // 1) Default matrix por roleCode mapeado desde Role legacy
  const code = legacyRoleToCode(user.role);
  const defaultPerms = getPermissionsForRoleCode(code);
  if (defaultPerms) {
    return !!defaultPerms[screen]?.[action];
  }

  // 2) Fallback: buscar en platform_roles (rol custom). Roles son globales.
  try {
    const roles = await listGlobalRoles();
    const role = roles.find((r) => r.code === code);
    if (role && role.permissions) {
      const perms = role.permissions as unknown as RolePermissionMap;
      return !!perms[screen]?.[action];
    }
  } catch (err) {
    logger.debug({ err, screen, action }, "rbac roles lookup failed");
  }

  // 3) Fail-closed
  return false;
}

/**
 * Versión sincrónica (sólo matriz default, sin DB).
 * Usar cuando no queremos hacer await en hot path.
 */
export function hasPermissionSync(
  user: User | null | undefined,
  screen: PlatformScreen,
  action: PermissionAction,
): boolean {
  if (!user || !user.active) return false;
  if (user.role === "admin") return true;
  const code = legacyRoleToCode(user.role);
  const perms = getPermissionsForRoleCode(code);
  if (!perms) return false;
  return !!perms[screen]?.[action];
}
