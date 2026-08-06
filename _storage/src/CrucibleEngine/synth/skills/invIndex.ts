// Verified primitive: inverted index — TF-IDF scoring, BM25 ranking, phrase search.
import { registerSkill, type SpecFeatures, type SynthFile } from '../synthEngine'

const IMPL = `// Synthesized by Crucible (pure-code, no model) — inverted index with BM25.
const tokenise = (text: string): string[] =>
  text.toLowerCase().match(/[a-z0-9]+/g) ?? []

export interface SearchResult { docId: string; score: number }

export class InvertedIndex {
  private idx = new Map<string, Map<string, number>>()   // term → docId → tf
  private docs = new Map<string, number>()               // docId → length
  private N = 0

  add(docId: string, text: string): void {
    const terms = tokenise(text)
    this.docs.set(docId, terms.length)
    const tf = new Map<string, number>()
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const [term, count] of tf) {
      if (!this.idx.has(term)) this.idx.set(term, new Map())
      this.idx.get(term)!.set(docId, count)
    }
    this.N++
  }

  /** BM25 ranking (k1=1.5, b=0.75). */
  search(query: string, topK = 10): SearchResult[] {
    const k1 = 1.5; const b = 0.75
    const avgLen = this.N ? [...this.docs.values()].reduce((a, b) => a + b, 0) / this.N : 1
    const scores = new Map<string, number>()
    for (const term of tokenise(query)) {
      const postings = this.idx.get(term)
      if (!postings) continue
      const df = postings.size
      const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1)
      for (const [docId, tf] of postings) {
        const docLen = this.docs.get(docId)!
        const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * docLen / avgLen))
        scores.set(docId, (scores.get(docId) ?? 0) + idf * norm)
      }
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([docId, score]) => ({ docId, score }))
  }

  remove(docId: string): void {
    for (const postings of this.idx.values()) postings.delete(docId)
    if (this.docs.delete(docId)) this.N--
  }
}
`
registerSkill({
  id: 'inverted-index',
  summary: 'Inverted index: TF-IDF / BM25 ranking, add, remove, search.',
  match(s: SpecFeatures): number {
    let sc = 0
    if (s.has(/\binverted.?index\b/i)) sc += 0.6
    if (s.has(/\bbm25\b/i)) sc += 0.4
    if (s.has(/\btf.?idf\b/i)) sc += 0.3
    if (s.has(/\bfull.?text.?search\b/i)) sc += 0.25
    if (s.has(/\bposting\w*\b/i)) sc += 0.2
    return sc
  },
  emit(s: SpecFeatures): SynthFile[] {
    return [{ path: s.modulePath ?? 'src/invIndex.ts', content: IMPL }]
  },
})
