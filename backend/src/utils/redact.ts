// =============================================================================
// redact.ts — Redacción defensiva de secretos y PII (Case Timeline · F0)
// =============================================================================
// Enmascara patrones de alto riesgo (tokens, claves, JWT, hashes, emails) antes
// de exponer texto libre (descripciones de eventos, logs, dumps) en el timeline
// del caso. Conservador: mata el secreto sin destruir el contexto útil.
//
// Alineado con el guardrail de secretos existente en ROCCO — nunca persistir ni
// mostrar credenciales en claro.
// =============================================================================

const MASK = "[REDACTED]";

const PATTERNS: { re: RegExp; replace: string }[] = [
  // Bearer / Authorization: <token>
  { re: /\b(bearer|authorization)(\s+)[A-Za-z0-9._\-]{12,}/gi, replace: `$1$2${MASK}` },
  // key = value / key: value  (password, secret, token, api_key, client_secret, access_key)
  {
    re: /\b(pass(?:word|wd)?|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)(\s*[:=]\s*)("?)[^\s"',;]{4,}\3/gi,
    replace: `$1$2${MASK}`,
  },
  // JWT (tres segmentos base64url que arrancan con eyJ)
  { re: /\beyJ[A-Za-z0-9._\-]{8,}\.[A-Za-z0-9._\-]{6,}\.[A-Za-z0-9._\-]{4,}\b/g, replace: `[JWT_${MASK}]` },
  // AWS access key id
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: `[AWSKEY_${MASK}]` },
  // Hex largo (>=32) — hashes / llaves
  { re: /\b[0-9a-fA-F]{32,}\b/g, replace: `[HEX_${MASK}]` },
];

/** Enmascara secretos y PII en un string. Idempotente y null-safe. */
export function redactSecrets(input: string | null | undefined): string {
  if (input === null || input === undefined) return "";
  let out = String(input);
  for (const { re, replace } of PATTERNS) out = out.replace(re, replace);
  // Email → primera letra + dominio (PII parcial): juan.perez@acme.cl → j***@acme.cl
  out = out.replace(
    /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    "$1***$2",
  );
  return out;
}

/** Recorta un texto largo a un preview seguro para el timeline. */
export function redactedPreview(input: string | null | undefined, max = 320): string {
  const r = redactSecrets(input);
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
}
