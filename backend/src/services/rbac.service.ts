// RBAC backend service.
// Persistencia real en Postgres de roles y usuarios de plataforma.
// Reemplaza el seed localStorage de buildDefaultRoles/buildDefaultUsers en el frontend.
//
// Importante: las pantallas (PlatformScreen) son enum del frontend; aquí guardamos
// permissions como JSONB para evitar acoplamiento de schema con cada pantalla nueva.

import { query } from "../database/db";
import { logger } from "../utils/logger";

let schemaEnsured = false;
let seeded = false;

export type ServiceLevel = "BASIC" | "STANDARD" | "PREMIUM" | "ENTERPRISE";
export type UserStatus = "ACTIVE" | "INACTIVE";

export interface RolePermission {
  view: boolean; create: boolean; edit: boolean; delete: boolean;
  export: boolean; configure: boolean; approve: boolean;
}
export type RolePermissionMap = Record<string, RolePermission>;

export interface PlatformRole {
  id: string;
  name: string;
  code: string;
  description: string;
  isSystem: boolean;
  permissions: RolePermissionMap;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformUser {
  id: string;
  name: string;
  email: string;
  roleCode: string;
  serviceLevel: ServiceLevel;
  status: UserStatus;
  createdAt: string;
}

// ============================================================
// Schema
// ============================================================

async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS platform_roles (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        code        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        is_system   BOOLEAN NOT NULL DEFAULT false,
        permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS platform_users (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL,
        role_code     TEXT NOT NULL,
        service_level TEXT NOT NULL DEFAULT 'STANDARD'
                      CHECK (service_level IN ('BASIC','STANDARD','PREMIUM','ENTERPRISE')),
        status        TEXT NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','INACTIVE')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_pu_role   ON platform_users(role_code);`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pu_status ON platform_users(status);`);
    schemaEnsured = true;
  } catch (err) {
    logger.warn({ err }, "ensure rbac schema failed");
  }
}

// ============================================================
// Default roles + users (espejo del seed del frontend)
// ============================================================

const ALL_SCREENS = [
  "dashboard", "agente_ams", "incidentes", "modulos_sap", "servicios",
  "reportes", "auditoria", "administracion", "configuracion",
  "canal_telefonico", "conocimiento_rag", "integraciones",
  "usuarios", "roles", "entrenamiento_ia",
  "playbooks_ams", "document_factory", "quality_evaluator",
  "escalamiento_n2", "testing_intelligence", "time_estimator",
];

function noPerm(): RolePermission { return { view:false,create:false,edit:false,delete:false,export:false,configure:false,approve:false }; }
function viewOnly(): RolePermission { return { ...noPerm(), view:true }; }
function viewExport(): RolePermission { return { ...noPerm(), view:true, export:true }; }
function viewCreate(): RolePermission { return { ...noPerm(), view:true, create:true }; }
function viewCreateEdit(): RolePermission { return { ...noPerm(), view:true, create:true, edit:true }; }
function viewExportApprove(): RolePermission { return { ...noPerm(), view:true, export:true, approve:true }; }
function fullPerm(): RolePermission { return { view:true,create:true,edit:true,delete:true,export:true,configure:true,approve:true }; }

function buildMap(spec: Partial<RolePermissionMap>): RolePermissionMap {
  const out = {} as RolePermissionMap;
  for (const s of ALL_SCREENS) out[s] = spec[s] ?? noPerm();
  return out;
}

const NOW = "2026-01-01T00:00:00.000Z";

function seedRoles(): PlatformRole[] {
  return [
    {
      id: "role_admin", name: "Administrador", code: "ADMIN",
      description: "Acceso total a la plataforma.", isSystem: true,
      createdAt: NOW, updatedAt: NOW,
      permissions: buildMap(Object.fromEntries(ALL_SCREENS.map((s) => [s, fullPerm()]))),
    },
    {
      id: "role_service_lead", name: "Líder de Servicio", code: "SERVICE_LEAD",
      description: "Aprueba, exporta y supervisa operación.", isSystem: true,
      createdAt: NOW, updatedAt: NOW,
      permissions: buildMap({
        dashboard: viewExportApprove(),
        agente_ams: viewCreateEdit(),
        incidentes: { ...viewCreateEdit(), export:true, approve:true },
        modulos_sap: viewExport(),
        servicios: { ...viewCreateEdit(), approve:true },
        reportes: viewExportApprove(),
        auditoria: viewExport(),
        administracion: viewOnly(),
        configuracion: { ...viewOnly(), configure:true },
        canal_telefonico: viewExport(),
        conocimiento_rag: viewCreateEdit(),
        integraciones: { ...viewCreateEdit(), approve:true },
        usuarios: viewOnly(),
        roles: viewOnly(),
        entrenamiento_ia: { ...viewCreateEdit(), export:true, approve:true },
        playbooks_ams: { ...viewCreateEdit(), export:true, approve:true },
        document_factory: { ...viewCreateEdit(), export:true, approve:true },
        quality_evaluator: { ...viewCreateEdit(), export:true, approve:true },
        escalamiento_n2: { ...viewCreateEdit(), export:true, configure:true, approve:true },
        testing_intelligence: { ...viewCreateEdit(), export:true, configure:true, approve:true },
        time_estimator: { ...viewCreateEdit(), export:true, approve:true },
      }),
    },
    {
      id: "role_ams_consultant", name: "Consultor AMS", code: "AMS_CONSULTANT",
      description: "Atiende consultas e incidentes.", isSystem: true,
      createdAt: NOW, updatedAt: NOW,
      permissions: buildMap({
        dashboard: viewExport(),
        agente_ams: viewCreateEdit(),
        incidentes: viewCreateEdit(),
        modulos_sap: viewOnly(),
        servicios: viewCreateEdit(),
        reportes: viewExport(),
        configuracion: viewOnly(),
        canal_telefonico: viewOnly(),
        conocimiento_rag: viewCreateEdit(),
        integraciones: viewOnly(),
        entrenamiento_ia: viewCreateEdit(),
        playbooks_ams: { ...viewCreateEdit(), export:true },
        document_factory: { ...viewCreateEdit(), export:true },
        quality_evaluator: viewCreateEdit(),
        escalamiento_n2: { ...viewCreateEdit(), export:true },
        testing_intelligence: { ...viewCreateEdit(), export:true },
        time_estimator: { ...viewCreateEdit(), export:true },
      }),
    },
    {
      id: "role_client_user", name: "Usuario Cliente", code: "CLIENT_USER",
      description: "Cliente final del servicio.", isSystem: true,
      createdAt: NOW, updatedAt: NOW,
      permissions: buildMap({
        dashboard: viewOnly(),
        agente_ams: viewCreate(),
        incidentes: viewCreate(),
        modulos_sap: viewOnly(),
        servicios: viewOnly(),
        configuracion: viewOnly(),
        conocimiento_rag: viewOnly(),
        playbooks_ams: viewOnly(),
        document_factory: viewOnly(),
        escalamiento_n2: viewOnly(),
        testing_intelligence: viewOnly(),
        time_estimator: viewOnly(),
      }),
    },
    {
      id: "role_general_user", name: "Usuario General", code: "GENERAL_USER",
      description: "Acceso básico.", isSystem: true,
      createdAt: NOW, updatedAt: NOW,
      permissions: buildMap({
        dashboard: viewOnly(),
        agente_ams: viewCreate(),
        modulos_sap: viewOnly(),
        configuracion: viewOnly(),
        conocimiento_rag: viewOnly(),
      }),
    },
  ];
}

function seedUsers(): PlatformUser[] {
  return [
    { id: "u_admin",     name: "Admin Sistema",   email: "admin@demo.cl",     roleCode: "ADMIN",          serviceLevel: "ENTERPRISE", status: "ACTIVE", createdAt: NOW },
    { id: "u_consultor", name: "Consultor AMS",   email: "consultor@demo.cl", roleCode: "AMS_CONSULTANT", serviceLevel: "PREMIUM",    status: "ACTIVE", createdAt: NOW },
    { id: "u_lider",     name: "Líder Servicio",  email: "lider@demo.cl",     roleCode: "SERVICE_LEAD",   serviceLevel: "ENTERPRISE", status: "ACTIVE", createdAt: NOW },
    { id: "u_cliente",   name: "Cliente Demo",    email: "cliente@demo.cl",   roleCode: "CLIENT_USER",    serviceLevel: "STANDARD",   status: "ACTIVE", createdAt: NOW },
    { id: "u_general",   name: "Usuario General", email: "usuario@demo.cl",   roleCode: "GENERAL_USER",   serviceLevel: "BASIC",      status: "ACTIVE", createdAt: NOW },
  ];
}

async function seedIfEmpty(): Promise<void> {
  if (seeded) return;
  try {
    const rc = await query<{ c: string }>("SELECT count(*)::text AS c FROM platform_roles");
    if (Number(rc.rows[0]?.c || "0") === 0) {
      for (const r of seedRoles()) {
        await query(
          `INSERT INTO platform_roles (id,name,code,description,is_system,permissions,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
          [r.id, r.name, r.code, r.description, r.isSystem, JSON.stringify(r.permissions),
           r.createdAt, r.updatedAt]
        );
      }
    }
    const uc = await query<{ c: string }>("SELECT count(*)::text AS c FROM platform_users");
    if (Number(uc.rows[0]?.c || "0") === 0) {
      for (const u of seedUsers()) {
        await query(
          `INSERT INTO platform_users (id,name,email,role_code,service_level,status,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [u.id, u.name, u.email, u.roleCode, u.serviceLevel, u.status, u.createdAt]
        );
      }
    }
    seeded = true;
  } catch (err) {
    logger.warn({ err }, "seed rbac failed");
  }
}

// ============================================================
// Backfill: cuando se agregan screens nuevas al código, los roles ya
// persistidos en DB no las tienen en permissions jsonb. Esta función
// las agrega:
//  - Roles is_system=true → re-sincronizan permisos con el seed actual
//    (idempotente, mantiene los roles del sistema siempre alineados al código).
//  - Roles custom         → agregan screens faltantes con noPerm() para
//    evitar undefined en hasPermission().
// Se ejecuta una vez por boot dentro de ready().
// ============================================================
let backfilled = false;
async function backfillMissingScreens(): Promise<void> {
  if (backfilled) return;
  try {
    const r = await query<RoleRow>("SELECT * FROM platform_roles");
    const seedByCode = new Map(seedRoles().map((s) => [s.code, s]));
    for (const row of r.rows) {
      const current = (row.permissions || {}) as RolePermissionMap;
      let next: RolePermissionMap;
      if (row.is_system && seedByCode.has(row.code)) {
        // Pisar con el seed actual (siempre en sync con código).
        next = seedByCode.get(row.code)!.permissions;
      } else {
        // Rol custom: agregar screens faltantes con noPerm().
        next = { ...current } as RolePermissionMap;
        let changed = false;
        for (const s of ALL_SCREENS) {
          if (!next[s as keyof RolePermissionMap]) {
            next[s as keyof RolePermissionMap] = noPerm();
            changed = true;
          }
        }
        if (!changed) continue;
      }
      await query(
        "UPDATE platform_roles SET permissions = $1::jsonb, updated_at = $2 WHERE id = $3",
        [JSON.stringify(next), new Date().toISOString(), row.id]
      );
    }
    backfilled = true;
  } catch (err) {
    logger.warn({ err }, "backfill rbac screens failed");
  }
}

async function ready() { await ensureSchema(); await seedIfEmpty(); await backfillMissingScreens(); }

// ============================================================
// Mappers
// ============================================================

interface RoleRow {
  id: string; name: string; code: string; description: string;
  is_system: boolean; permissions: RolePermissionMap;
  created_at: string; updated_at: string;
}
function mapRole(r: RoleRow): PlatformRole {
  return {
    id: r.id, name: r.name, code: r.code, description: r.description,
    isSystem: r.is_system, permissions: r.permissions || {},
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface UserRow {
  id: string; name: string; email: string; role_code: string;
  service_level: ServiceLevel; status: UserStatus; created_at: string;
}
function mapUser(r: UserRow): PlatformUser {
  return {
    id: r.id, name: r.name, email: r.email, roleCode: r.role_code,
    serviceLevel: r.service_level, status: r.status, createdAt: r.created_at,
  };
}

// ============================================================
// API
// ============================================================

export async function getSnapshot(): Promise<{ roles: PlatformRole[]; users: PlatformUser[] }> {
  await ready();
  const [rR, uR] = await Promise.all([
    query<RoleRow>("SELECT * FROM platform_roles ORDER BY name"),
    query<UserRow>("SELECT * FROM platform_users ORDER BY name"),
  ]);
  return { roles: rR.rows.map(mapRole), users: uR.rows.map(mapUser) };
}

export async function upsertRole(r: PlatformRole): Promise<PlatformRole> {
  await ready();
  const now = new Date().toISOString();
  const res = await query<RoleRow>(
    `INSERT INTO platform_roles (id,name,code,description,is_system,permissions,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, code=EXCLUDED.code, description=EXCLUDED.description,
       is_system=EXCLUDED.is_system, permissions=EXCLUDED.permissions,
       updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [r.id, r.name, r.code, r.description, r.isSystem, JSON.stringify(r.permissions || {}),
     r.createdAt || now, now]
  );
  return mapRole(res.rows[0]);
}

export async function deleteRole(id: string): Promise<void> {
  await ready();
  await query("DELETE FROM platform_roles WHERE id = $1 AND is_system = false", [id]);
}

export async function upsertUser(u: PlatformUser): Promise<PlatformUser> {
  await ready();
  const now = new Date().toISOString();
  const res = await query<UserRow>(
    `INSERT INTO platform_users (id,name,email,role_code,service_level,status,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, email=EXCLUDED.email, role_code=EXCLUDED.role_code,
       service_level=EXCLUDED.service_level, status=EXCLUDED.status
     RETURNING *`,
    [u.id, u.name, u.email, u.roleCode, u.serviceLevel, u.status, u.createdAt || now]
  );
  return mapUser(res.rows[0]);
}

export async function deleteUser(id: string): Promise<void> {
  await ready();
  await query("DELETE FROM platform_users WHERE id = $1", [id]);
}

export async function resetDemo(): Promise<void> {
  await ensureSchema();
  await query("DELETE FROM platform_users");
  await query("DELETE FROM platform_roles");
  seeded = false;
  await seedIfEmpty();
}
