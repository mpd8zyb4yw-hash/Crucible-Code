// Local content-word token-cosine for the response cache's paraphrase lookup — pure, no premium
// model (true to the free-tier philosophy). Extracted from server.ts so the tokenization and
// similarity math are unit-testable; server.ts keeps the cache state + threshold that use them.
// The vec/cosine pair is deliberately isolated so a real embedding backend can swap in later.

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'do', 'does', 'can', 'you', 'i', 'me', 'my', 'please', 'write', 'give', 'show', 'tell', 'what', 'how', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'will', 'would', 'should', 'could'])

/** Minimal stemmer: strip only a trailing plural / 3rd-person 's' so morphological variants
 *  collapse ("reverse"≈"reverses", "string"≈"strings") without the over-stemming that
 *  'ing'/'es'/'ed' rules cause on nouns ("string"→"str"). Guarded on length and 'ss'. */
export function stem(t: string): string {
  return t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t
}

/** Bag-of-stemmed-content-words term-frequency vector. */
export function vectorize(message: string): Map<string, number> {
  const vec = new Map<string, number>()
  const tokens = (message.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])
    .filter(t => !STOPWORDS.has(t))
    .map(stem)
  for (const t of tokens) vec.set(t, (vec.get(t) ?? 0) + 1)
  return vec
}

/** Cosine similarity of two term-frequency vectors in [0, 1]; 0 if either is empty. */
export function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  if (!a.size || !b.size) return 0
  let dot = 0
  for (const [t, w] of a) { const bw = b.get(t); if (bw) dot += w * bw }
  let na = 0; for (const w of a.values()) na += w * w
  let nb = 0; for (const w of b.values()) nb += w * w
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
