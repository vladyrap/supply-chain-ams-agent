// =============================================================================
// smoke-agents.ts — v1.3 onda 7 · Suite smoke del Agent Hub
// =============================================================================
// Verifica el ciclo completo de creación y publicación de agentes:
//   - Auth requerida en /api/agents
//   - Catálogo de modelos (5 LLM con disponibilidad)
//   - Guardrail anti-secretos (API key en instrucciones → 400)
//   - Whitelist de modelos (modelo inválido → 400)
//   - Identidad de sesión (createdBy del body se ignora)
//   - Publicar (validaciones) / despublicar
//   - Bloqueo optimista (expectedUpdatedAt viejo → 409)
//   - Archivar / reactivar (status=archived)
//   - Versiones (snapshot al editar) + stats
//   - Export masivo solo admin
//   - Limpieza total al final
//
// Uso (requiere backend corriendo y usuario admin):
//   BASE_URL=http://localhost:6601 ORIGIN=http://localhost:6700 \
//     ADMIN_EMAIL=admin@demo.cl ADMIN_PASSWORD=... npx tsx scripts/smoke-agents.ts
// =============================================================================

import assert from "node:assert/strict";

const BASE = (process.env.BASE_URL || "http://localhost:6601").replace(/\/+$/, "");
const ORIGIN = process.env.ORIGIN || "http://localhost:6700";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@demo.cl";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let passed = 0, failed = 0;
let cookie = "";
let agentId = "";

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}`);
    failed++;
  }
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: ORIGIN,
    Cookie: `ams_session=${cookie}`,
  };
}

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try { json = await r.json() as Record<string, unknown>; } catch { /* respuesta no-JSON */ }
  return { status: r.status, json };
}

async function main() {
  console.log(`\n[smoke-agents] BASE=${BASE}\n`);

  if (!ADMIN_PASSWORD) {
    console.log("  ⚠ ADMIN_PASSWORD no seteada — abortando (no se puede probar el flujo autenticado).");
    process.exit(1);
  }

  // === Auth ===
  await test("GET /api/agents sin cookie → 401", async () => {
    const r = await fetch(`${BASE}/api/agents`);
    assert.equal(r.status, 401);
  });

  await test("login admin OK", async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    assert.equal(r.status, 200);
    const m = (r.headers.get("set-cookie") ?? "").match(/ams_session=([^;]+)/);
    assert.ok(m, "sin cookie ams_session");
    cookie = m![1];
  });

  // === Catálogo de modelos ===
  await test("GET /api/agents/models → 5 modelos con disponibilidad", async () => {
    const { status, json } = await api("GET", "/api/agents/models");
    assert.equal(status, 200);
    const models = json.models as Array<{ id: string; available: boolean }>;
    assert.equal(models.length, 5, `esperaba 5 modelos, hay ${models.length}`);
    assert.ok(models.every((m) => typeof m.available === "boolean"));
  });

  // === Guardrails de creación ===
  await test("crear con API key en instrucciones → 400 (anti-secretos)", async () => {
    const { status } = await api("POST", "/api/agents", {
      name: "Smoke Secreto", category: "CO",
      instructions: "Autentica con api_key=AIzaSyFAKEFAKEFAKEFAKEFAKEFAKE99 contra el endpoint.",
    });
    assert.equal(status, 400);
  });

  await test("crear con modelo inválido → 400 (whitelist)", async () => {
    const { status } = await api("POST", "/api/agents", {
      name: "Smoke Modelo", category: "CO", model: "gpt-99",
      instructions: "Agente de prueba de whitelist con mas de treinta caracteres aqui.",
    });
    assert.equal(status, 400);
  });

  // === Identidad de sesión ===
  await test("createdBy del body se ignora (dueño = sesión)", async () => {
    const { status, json } = await api("POST", "/api/agents", {
      name: "Smoke Hub", description: "Agente del smoke test", category: "CO",
      instructions: "Eres un agente temporal del smoke test del hub. Respondes siempre SMOKE-OK.",
      createdBy: "hacker@evil.com",
    });
    assert.equal(status, 201);
    const agent = json.agent as { id: string; createdBy: string };
    assert.equal(agent.createdBy, ADMIN_EMAIL, `createdBy=${agent.createdBy}`);
    agentId = agent.id;
  });

  // === Publicación ===
  await test("publicar → visibility team + publishedBy sesión", async () => {
    const { status, json } = await api("POST", `/api/agents/${agentId}/publish`, {});
    assert.equal(status, 200);
    const agent = json.agent as { visibility: string; publishedBy: string };
    assert.equal(agent.visibility, "team");
    assert.equal(agent.publishedBy, ADMIN_EMAIL);
  });

  await test("despublicar → vuelve a private", async () => {
    const { status, json } = await api("POST", `/api/agents/${agentId}/unpublish`, {});
    assert.equal(status, 200);
    assert.equal((json.agent as { visibility: string }).visibility, "private");
  });

  // === Bloqueo optimista + versiones ===
  await test("update con expectedUpdatedAt vigente → 200 (crea versión)", async () => {
    const { json } = await api("GET", `/api/agents/${agentId}`);
    const current = json.agent as { updatedAt: string };
    const { status } = await api("PUT", `/api/agents/${agentId}`, {
      instructions: "Version DOS del agente smoke con mas de treinta caracteres para el snapshot.",
      expectedUpdatedAt: current.updatedAt,
    });
    assert.equal(status, 200);
  });

  await test("update con expectedUpdatedAt viejo → 409 (conflicto)", async () => {
    const { status } = await api("PUT", `/api/agents/${agentId}`, {
      instructions: "Version pirata que deberia rebotar por conflicto de edicion concurrente.",
      expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
    assert.equal(status, 409);
  });

  await test("historial tiene al menos 1 versión", async () => {
    const { status, json } = await api("GET", `/api/agents/${agentId}/versions`);
    assert.equal(status, 200);
    assert.ok((json.versions as unknown[]).length >= 1);
  });

  // === Archivar / reactivar ===
  await test("archivar → sale de activos, entra en ?status=archived", async () => {
    await api("PUT", `/api/agents/${agentId}`, { status: "archived" });
    const act = await api("GET", "/api/agents");
    const arc = await api("GET", "/api/agents?status=archived");
    const inActive = (act.json.agents as Array<{ id: string }>).some((a) => a.id === agentId);
    const inArchived = (arc.json.agents as Array<{ id: string }>).some((a) => a.id === agentId);
    assert.equal(inActive, false, "sigue en activos");
    assert.equal(inArchived, true, "no está en archivados");
  });

  await test("reactivar → vuelve a activos", async () => {
    const { status } = await api("PUT", `/api/agents/${agentId}`, { status: "active" });
    assert.equal(status, 200);
  });

  // === Stats + export ===
  await test("GET /:id/stats responde con contadores", async () => {
    const { status, json } = await api("GET", `/api/agents/${agentId}/stats`);
    assert.equal(status, 200);
    const stats = json.stats as { conversations: number };
    assert.ok(typeof stats.conversations === "number");
  });

  await test("GET /api/agents/export (admin) → respaldo con count", async () => {
    const { status, json } = await api("GET", "/api/agents/export");
    assert.equal(status, 200);
    assert.ok((json.count as number) >= 1);
    assert.equal(json.exportedBy, ADMIN_EMAIL);
  });

  // === Limpieza ===
  await test("eliminar agente smoke → 200", async () => {
    const { status } = await api("DELETE", `/api/agents/${agentId}`);
    assert.equal(status, 200);
  });

  console.log(`\n[smoke-agents] ${passed} passed · ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[smoke-agents] error fatal:", err);
  process.exit(1);
});
