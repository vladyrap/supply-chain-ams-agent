// =============================================================================
// smoke-rbac.ts — DH v0.9 · Smoke test del RBAC backend
// =============================================================================
// Verifica:
//   - Endpoints públicos siguen accesibles (health)
//   - Endpoints protegidos sin cookie → 401
//   - Endpoints protegidos con cookie inválida → 401
//   - (Opcional) Si AMS_BOOTSTRAP_ADMIN_EMAIL/PASSWORD seteadas:
//     - Login admin → cookie OK
//     - GET protected con cookie admin → 200
//
// Uso:
//   BASE_URL=http://localhost:6601 \
//     ADMIN_EMAIL=admin@demo.cl ADMIN_PASSWORD=cambiame \
//     npx tsx scripts/smoke-rbac.ts
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

/** Extrae el valor de la cookie ams_session del Set-Cookie header. */
function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = setCookie.match(/ams_session=([^;]+)/);
  return m ? m[1] : null;
}

async function main() {
  console.log(`\n[smoke-rbac] BASE=${BASE}\n`);

  // === Públicos ===
  await test("GET /health pasa sin auth", async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200);
  });

  // === Protegidos sin auth → 401 ===
  await test("GET /api/tickets sin cookie → 401", async () => {
    const r = await fetch(`${BASE}/api/tickets`);
    assert.equal(r.status, 401, `expected 401 got ${r.status}`);
  });

  await test("POST /api/tickets sin cookie → 401", async () => {
    const r = await fetch(`${BASE}/api/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "smoke" }),
    });
    assert.equal(r.status, 401);
  });

  await test("GET /api/audit/events sin cookie → 401", async () => {
    const r = await fetch(`${BASE}/api/audit/events`);
    assert.equal(r.status, 401);
  });

  await test("GET /api/rbac/snapshot sin cookie → 401", async () => {
    const r = await fetch(`${BASE}/api/rbac/snapshot`);
    assert.equal(r.status, 401);
  });

  await test("Cookie inválida → 401", async () => {
    const r = await fetch(`${BASE}/api/tickets`, {
      headers: { Cookie: "ams_session=invalido123" },
    });
    assert.equal(r.status, 401);
  });

  // === Si tenemos credenciales admin, validamos 200 y 403 ===
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    let adminCookie: string | null = null;

    await test("POST /api/auth/login admin → 200 + cookie", async () => {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      assert.equal(r.status, 200, `login status ${r.status}`);
      const setCookie = r.headers.get("set-cookie");
      adminCookie = extractSessionCookie(setCookie);
      assert.ok(adminCookie, "no se extrajo cookie ams_session");
    });

    if (adminCookie) {
      await test("GET /api/tickets con cookie admin → 200", async () => {
        const r = await fetch(`${BASE}/api/tickets`, {
          headers: { Cookie: `ams_session=${adminCookie}` },
        });
        assert.equal(r.status, 200, `expected 200 got ${r.status}`);
      });

      await test("GET /api/rbac/snapshot con cookie admin → 200", async () => {
        const r = await fetch(`${BASE}/api/rbac/snapshot`, {
          headers: { Cookie: `ams_session=${adminCookie}` },
        });
        assert.equal(r.status, 200);
      });

      await test("GET /api/audit/events con cookie admin → 200", async () => {
        const r = await fetch(`${BASE}/api/audit/events`, {
          headers: { Cookie: `ams_session=${adminCookie}` },
        });
        assert.equal(r.status, 200);
      });
    }
  } else {
    console.log(
      `  ⚠ Saltando tests con auth (no hay ADMIN_EMAIL/ADMIN_PASSWORD env vars).`,
    );
  }

  console.log(`\n[smoke-rbac] ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[smoke-rbac] unexpected:", err);
  process.exit(2);
});
