// Chunking por caracteres con overlap, intentando cortar en límite de párrafo/frase.
export interface Chunk {
  index: number;
  content: string;
  estimatedTokens: number;
}

const CHUNK_CHARS = parseInt(process.env.RAG_CHUNK_CHARS || "3500", 10);
const OVERLAP = parseInt(process.env.RAG_CHUNK_OVERLAP || "400", 10);

function findGoodSplit(text: string, target: number): number {
  // Buscar el ultimo \n\n, \n, ". ", "; " o " " antes de target.
  const window = text.slice(0, target);
  const candidates = ["\n\n", "\n", ". ", "; "];
  for (const sep of candidates) {
    const idx = window.lastIndexOf(sep);
    // No cortar muy temprano (al menos 60% del target)
    if (idx > target * 0.6) return idx + sep.length;
  }
  const sp = window.lastIndexOf(" ");
  if (sp > target * 0.6) return sp + 1;
  return target;
}

export function chunkText(text: string): Chunk[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (clean.length === 0) return [];
  if (clean.length <= CHUNK_CHARS) {
    return [{ index: 0, content: clean, estimatedTokens: Math.ceil(clean.length / 4) }];
  }
  const chunks: Chunk[] = [];
  let i = 0;
  let idx = 0;
  while (i < clean.length) {
    const remaining = clean.length - i;
    if (remaining <= CHUNK_CHARS) {
      const piece = clean.slice(i).trim();
      if (piece) chunks.push({ index: idx++, content: piece, estimatedTokens: Math.ceil(piece.length / 4) });
      break;
    }
    const split = findGoodSplit(clean.slice(i), CHUNK_CHARS);
    const piece = clean.slice(i, i + split).trim();
    if (piece) chunks.push({ index: idx++, content: piece, estimatedTokens: Math.ceil(piece.length / 4) });
    i = i + split - OVERLAP;
    if (i < 0) i = 0;
  }
  return chunks;
}
