// =============================================================================
// smoke-audit.ts — DH v0.9 · Smoke test de Audit Trail backend
// =============================================================================
// Verifica:
//   - POST /api/audit/events crea un evento (requiere auth)
//   - GET /api/audit/events lo lista (requiere audit_trail.view)
//   - GET /api/audit/summary devuelve totales
//
// Uso:
//   BASE_URL=http://localhost:6601 \
//     ADMIN_EMAIL=admin@demo.cl ADMIN_PASSWORD=cambiame \
//     npx tsx scripts/smoke-audit.ts
// =============================================================================

import assert from "node:assert/strict";

const BASE = (process.env.BASE_URL || "http://localhost:6601").replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

let passed = 0, failed = 0;

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

function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = setCookie.match(/ams_session=([^;]+)/);
  return m ? m[1] : null;
}

async function main() {
  console.log(`\n[smoke-audit] BASE=${BASE}\n`);

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log(`  ⚠ ADMIN_EMAIL/PASSWORD no seteadas — saltando smoke-audit.`);
    console.log(`  Setea las env vars y reintentá.`);
    process.exit(0);
  }

  // Login admin para obtener cookie
  let adminCookie: string | null = null;
  await test("Login admin", async () => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    assert.equal(r.status, 200, `status ${r.status}`);
    adminCookie = extractSessionCookie(r.headers.get("set-cookie"));
    assert.ok(adminCookie);
  });

  if (!adminCookie) {
    console.log("\n[smoke-audit] no se pudo obtener cookie admin");
    process.exit(1);
  }

  const cookie = `ams_session=${adminCookie}`;
  const correlationId = `smoke_${Date.now()}`;

  // POST evento
  let createdEventId: string | null = null;
  await test("POST /api/audit/events → 201 + record", async () => {
    const r = await fetch(`${BASE}/api/audit/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        eventType: "TICKET_CREATED",
        category: "ticket",
        severity: "info",
        source: "api",
        ticketId: `SMOKE-${Date.now()}`,
        payload: { title: "Smoke test event", description: "creado por smoke-audit.ts" },
        correlationId,
      }),
    });
    assert.equal(r.status, 201, `expected 201 got ${r.status}`);
    const data = await r.json() as { success: boolean; event?: { id: string } };
    assert.ok(data.success && data.event?.id, "no event in response");
    createdEventId = data.event!.id;
  });

  // GET listado
  await test("GET /api/audit/events incluye el evento creado", async () => {
    const r = await fetch(`${BASE}/api/audit/events?eventType=TICKET_CREATED&limit=50`, {
      headers: { Cookie: cookie },
    });
    assert.equal(r.status, 200);
    const data = await r.json() as { success: boolean; events: Array<{ id: string }> };
    assert.ok(data.success);
    assert.ok(data.events.some((e) => e.id === createdEventId), "evento no encontrado en listado");
  });

  // GET summary
  await test("GET /api/audit/summary → totales", async () => {
    const r = await fetch(`${BASE}/api/audit/summary`, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    const data = await r.json() as { success: boolean; summary: { total: number } };
    assert.ok(data.success);
    assert.ok(data.summary.total >= 1, "total debe ser >= 1");
  });

  // Validación negativa: POST sin auth → 401
  await test("POST /api/audit/events sin cookie → 401", async () => {
    const r = await fetch(`${BASE}/api/audit/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "TICKET_CREATED" }),
    });
    assert.equal(r.status, 401);
  });

  console.log(`\n[smoke-audit] ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[smoke-audit] unexpected:", err);
  process.exit(2);
});
