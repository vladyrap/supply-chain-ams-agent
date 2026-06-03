// =============================================================================
// smoke-health.ts — DH v0.9 · Smoke test del endpoint /health
// =============================================================================
// Verifica que el backend esté arriba. Es el smoke más rápido.
//
// Uso:
//   BASE_URL=http://localhost:6601 npx tsx scripts/smoke-health.ts
//   # default BASE_URL = http://localhost:6601
//
// Exit 0 = OK, exit 1 = falla.
// =============================================================================

import assert from "node:assert/strict";

const BASE = (process.env.BASE_URL || "http://localhost:6601").replace(/\/+$/, "");
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

async function main() {
  console.log(`\n[smoke-health] BASE=${BASE}\n`);

  await test("GET /health → 200", async () => {
    const r = await fetch(`${BASE}/health`);
    assert.equal(r.status, 200, `expected 200 got ${r.status}`);
    const data = await r.json() as { ok?: boolean; status?: string };
    assert.ok(data.ok === true || data.status === "ok", "expected ok:true or status:ok");
  });

  await test("GET /health/deep → 200", async () => {
    const r = await fetch(`${BASE}/health/deep`);
    assert.equal(r.status, 200, `expected 200 got ${r.status}`);
  });

  console.log(`\n[smoke-health] ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[smoke-health] unexpected:", err);
  process.exit(2);
});
