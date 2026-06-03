// =============================================================================
// Prompt Loader v0.13 — Carga prompts por tarea y los concatena con system-base
// =============================================================================
// Reemplaza la carga monolítica de `ams-system-prompt.md` por una carga modular:
//   - Existe SIEMPRE un "system base" (el ams-system-prompt.md actual)
//   - Por tarea hay un prompt pack opcional (classify, customer_response, etc.)
//   - Final prompt = system_base + "\n\n---\n\n" + task_pack
//
// Si el pack no existe, se devuelve solo el system base — paridad con v0.12.
// Cache con TTL para no leer disco en cada request.
// =============================================================================

import { readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../utils/logger";

const PROMPTS_DIR = path.resolve(process.cwd(), "prompts");
const SYSTEM_BASE_FILE = "ams-system-prompt.md";
const CACHE_TTL_MS = 60_000;

interface CachedPrompt { text: string; expiresAt: number }
const cache = new Map<string, CachedPrompt>();

async function readPromptFile(filename: string): Promise<string | null> {
  const cached = cache.get(filename);
  if (cached && cached.expiresAt > Date.now()) return cached.text;
  try {
    const text = await readFile(path.join(PROMPTS_DIR, filename), "utf-8");
    cache.set(filename, { text, expiresAt: Date.now() + CACHE_TTL_MS });
    return text;
  } catch (err) {
    // Pack opcional — si no existe, no es error fatal
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.debug({ filename }, "prompt pack not found, using base only");
      return null;
    }
    throw err;
  }
}

/**
 * Carga el system prompt para una tarea específica.
 * @param promptPack nombre del archivo sin extensión (ej. "classify", "customer_response")
 * @returns el system prompt final (base + pack si existe)
 */
export async function loadPromptForTask(promptPack: string): Promise<string> {
  const base = await readPromptFile(SYSTEM_BASE_FILE);
  if (!base) {
    throw new Error(`System base prompt no encontrado en ${PROMPTS_DIR}/${SYSTEM_BASE_FILE}`);
  }
  if (promptPack === "system-base") return base;

  const pack = await readPromptFile(`${promptPack}.prompt.md`);
  if (!pack) return base; // pack no existe → solo base
  return `${base}\n\n---\n\n${pack}`;
}

/**
 * Helper para sustituir placeholders {{KEY}} en el prompt pack.
 * Útil para inyectar contexto del ticket sin templates externos.
 */
export function fillPlaceholders(prompt: string, vars: Record<string, string>): string {
  let out = prompt;
  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp(`\\{\\{${key}\\}\\}`, "g");
    out = out.replace(re, value);
  }
  return out;
}

/** Limpia el cache — útil para tests. */
export function clearPromptCache(): void {
  cache.clear();
}
