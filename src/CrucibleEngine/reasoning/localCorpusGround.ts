// ═══════════════════════════════════════════════════════════════════════════════
// OFFLINE RETRIEVAL SOURCE — a `webGround` backed by the packages already on disk.
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS. `withRetrieval` (solve.ts) is the mechanism the decomposition path was built
// around: corner the capability gap into ONE precisely-named helper, then RETRIEVE a real
// implementation of exactly that sub-problem instead of asking a 1.5B to invent it. On 2026-08-02
// an audit found that mechanism has never run in a live measurement — `webGround` is supplied in
// exactly two places, both stubbed unit benches, so `withRetrieval` returns the base proposer
// unchanged on every scorecard and post-mortem draw ever recorded. The lever the architecture
// leans on is dark, and the hand-carve probe just showed the proposer ceiling it was meant to
// relieve is real (`splitCsvLine`: 0 certifications in 290 model calls across 12 attempts at a
// correct hand-written carve).
//
// WHY LOCAL RATHER THAN THE WEB. Doctrine allows the internet as a DATA source (only external
// paid/rate-limited MODEL API calls are banned), so a web retriever is legal — but it is also
// non-deterministic, unavailable offline, and impossible to re-run identically six months from
// now. The installed dependency tree is a real code corpus that is none of those things: ~600
// packages of human-written JavaScript, already on disk, byte-identical on every re-run.
//
// WHY IT IS NOT SELF-MEMORIZATION — the trap this repo has already fallen into once (a distilled
// `_learned/` catalog turning corpus tasks into zero-inference hits). Three properties keep this
// honest, and they are properties of the CORPUS, not promises about intent:
//   1. It is PRE-EXISTING and TASK-INDEPENDENT. Nothing here was authored to answer a bench row;
//      it is whatever `npm install` put on disk for unrelated reasons.
//   2. It is not curated per task. The same corpus and the same ranking answer every query.
//   3. It demonstrably lacks the answers to the rows it will be measured on — there is no CSV
//      parser among the installed packages (checked 2026-08-02). `describeCorpus()` exists so a
//      bench can PRINT what the shelf actually holds instead of asserting this in prose.
// A retrieval arm must still be reported on its own line and never pooled with a no-retrieval
// capability number, exactly as the decompose-only control is.
//
// SOUNDNESS. Retrieved text only ever grounds the PROPOSER. Every candidate built from it is
// executed against the rung's own cases by the same verifier as an invented one, so a wrong or
// irrelevant retrieval costs draws and can never certify a wrong answer. This file does no
// network I/O, spawns no process, and never writes — it reads files under a fixed root.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface LocalCorpusOpts {
  /** Directory to shelve. Default `<cwd>/node_modules`. */
  root?: string
  /** Max files whose contents are RETURNED (one blob each — see makeRetrievalProposer). Default 5. */
  maxFiles?: number
  /** Max bytes per returned blob. A retrieved file is proposer context, not an archive. Default 24k. */
  maxBytesPerFile?: number
  /** Hard cap on files STATTED during a scan, so a pathological tree can't hang a rung. Default 20k. */
  maxFilesScanned?: number
  /** Optional progress sink (shares the search emit shape). */
  emit?: (e: Record<string, unknown>) => void
}

/** Tokens that carry no retrieval signal — dropping them keeps scoring on the domain words. */
const STOPWORDS = new Set([
  'write', 'a', 'an', 'the', 'of', 'in', 'is', 'it', 'its', 'and', 'or', 'not', 'that', 'this',
  'with', 'for', 'from', 'into', 'to', 'be', 'are', 'as', 'by', 'on', 'at', 'if', 'then', 'else',
  'return', 'returns', 'returned', 'returning', 'function', 'string', 'number', 'boolean', 'array',
  'implement', 'helper', 'value', 'values', 'input', 'output', 'given', 'every', 'each', 'one',
  'javascript', 'code', 'must', 'should', 'may', 'which', 'case', 'cases', 'when', 'no', 'any',
])

/**
 * Query → scoring keywords. A rung goal is an English sentence, so the useful signal is its
 * domain nouns and verbs (`split`, `csv`, `quote`, `comma`) plus any camelCase identifier, which
 * is also split into parts (`splitCsvLine` → split, csv, line) because a corpus file names things
 * its own way and would otherwise never match the caller's exact identifier.
 */
export function queryKeywords(query: string): string[] {
  const out = new Set<string>()
  for (const raw of query.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_]+/)
    for (const p of parts) {
      if (p.length < 3 || STOPWORDS.has(p)) continue
      out.add(p)
    }
  }
  return [...out]
}

/** Files worth reading: hand-written JS/TS source, not bundles, maps, minified builds or types. */
function isCandidateFile(name: string): boolean {
  if (!/\.(js|mjs|cjs|ts)$/.test(name)) return false
  if (/\.min\.js$/.test(name)) return false
  if (/\.d\.ts$/.test(name)) return false          // declarations carry no implementation
  if (/\.map$/.test(name)) return false
  return true
}

/**
 * SYNTAX-HIGHLIGHTER LANGUAGE DEFINITIONS AND EDITOR BUNDLES — keyword-dense, implementation-free.
 * Measured on the live retrieval arm: a "split on commas outside double quotes" query returned
 * `highlight.js/lib/languages/vim.js`, `prismjs/components/prism-avisynth.js` and
 * `typescript/lib/_tsserver.js` in its top five. A grammar definition is a table of the exact words
 * the query is made of and contains no reusable logic, so it wins on keyword score while teaching
 * the proposer nothing — and each one costs a retrieval candidate slot that a real implementation
 * could have used (only 1 of the 5 hits, shell-quote/parse.js, was an actual quote-state scanner).
 * Excluded by PATH rather than by content: these live in predictable places, and reading them to
 * find out is what costs the time.
 */
function isNoiseSourcePath(relPath: string): boolean {
  const p = relPath.toLowerCase()
  return /(^|\/)(highlight\.js|prismjs|shiki|linguist)(\/|$)/.test(p) ||
    /(^|\/)languages\//.test(p) ||
    /(^|\/)components\/prism-/.test(p) ||
    /(^|\/)typescript\/lib\//.test(p) ||
    /(^|\/)locales?\//.test(p)
}

/** Directories that are all build output or noise — skipping them is most of the scan budget. */
function isSkippedDir(name: string): boolean {
  return name === '.bin' || name === '.cache' || name === 'dist' || name === 'umd' ||
    name === 'esm' || name === 'test' || name === 'tests' || name === '__tests__' ||
    name === 'fixtures' || name === 'coverage' || name.startsWith('.')
}

interface ScanHit { path: string; score: number; size: number }

/**
 * Walk the shelf scoring files by keyword hits. Deliberately dumb: no index, no embeddings, one
 * pass, bounded. It is a BASELINE — the point is to find out what retrieval is worth on a cornered
 * rung before investing in an index. Scoring reads only the first `HEAD_BYTES` of a file so a large
 * bundle costs the same as a small module; a file whose relevance only shows up 200kB in is not a
 * file a 1.5B's context can use anyway.
 */
const HEAD_BYTES = 64_000

function scan(root: string, keywords: string[], maxFilesScanned: number): ScanHit[] {
  const hits: ScanHit[] = []
  let scanned = 0
  const stack: string[] = [root]
  while (stack.length) {
    if (scanned >= maxFilesScanned) break
    const dir = stack.pop()!
    let entries: string[]
    // A shelf is other people's files: unreadable dirs, broken symlinks and permission errors are
    // NORMAL here and must degrade the result, never fail the rung that asked for grounding.
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (scanned >= maxFilesScanned) break
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (!isSkippedDir(name)) stack.push(full)
        continue
      }
      if (!isCandidateFile(name)) continue
      if (isNoiseSourcePath(full.slice(root.length + 1))) continue
      scanned++
      let head: string
      try { head = readFileSync(full, 'utf8').slice(0, HEAD_BYTES) } catch { continue }
      const hay = head.toLowerCase()
      let score = 0
      for (const k of keywords) {
        // Count occurrences, but with sharply diminishing returns: a file that mentions `split`
        // 400 times is not 400x more relevant than one that mentions it twice, and without the cap
        // a single big utility bundle wins every query regardless of subject.
        let n = 0, i = hay.indexOf(k)
        while (i !== -1 && n < 8) { n++; i = hay.indexOf(k, i + k.length) }
        if (n) score += 1 + Math.log2(n)
      }
      // Breadth is a WEIGHT, not a gate. Requiring two distinct keywords looks reasonable and is
      // wrong: a goal's keywords are frequently variants of ONE concept (`quotes`, `quoted`,
      // `unescape`), so the single most on-topic file in the corpus routinely matches only one of
      // them and a hard filter discards precisely the file worth retrieving. Weighting instead
      // keeps it, while still ranking a file that matches several concepts above a one-word
      // coincidence (`line` in a logger). Caught by the selfcheck's ranking case, which failed
      // against the gate and passes against the weight.
      const distinct = keywords.filter(k => hay.includes(k)).length
      if (!distinct) continue

      // DENSITY, NOT VOLUME. Measured 2026-08-02 against the real tree: raw keyword scoring returns
      // `@babel/parser/lib/index.js` and similar 500kB bundles for every query, because a big enough
      // file mentions every word eventually. Those are the WORST possible proposer context — the
      // blob cap means the model receives the first 24kB, which is a bundle's import prologue and
      // contains nothing about the topic. Dividing by log(size) asks "how much of this file is about
      // my query" instead of "does this file contain my query", which is the actual question.
      const sizeKb = Math.max(1, st.size / 1024)
      const density = score / Math.log2(sizeKb + 2)

      // PATH RELEVANCE. A corpus names things: `shell-quote/parse.js` announces its subject in its
      // path, and a package/file name matching the query is far stronger evidence than another
      // in-body mention. Applied as a bounded multiplier so it re-ranks without letting a lucky
      // filename outvote a file that is genuinely about the topic.
      const relPath = full.slice(root.length + 1).toLowerCase()
      const pathHits = keywords.filter(k => relPath.includes(k)).length
      const pathBonus = 1 + Math.min(2, pathHits)

      hits.push({ path: full, score: density * Math.pow(distinct, 1.5) * pathBonus, size: st.size })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits
}

/**
 * Build a `webGround` over the installed packages. Signature-compatible with the injected retriever
 * `solve.ts` already threads through `withRetrieval`, so wiring it costs one argument at the call
 * site and nothing in the loop.
 */
export function makeLocalCorpusGround(opts: LocalCorpusOpts = {}): (query: string) => Promise<string[] | null> {
  const root = opts.root ?? join(process.cwd(), 'node_modules')
  const maxFiles = opts.maxFiles ?? 5
  const maxBytes = opts.maxBytesPerFile ?? 24_000
  const maxScanned = opts.maxFilesScanned ?? 20_000
  const emit = opts.emit ?? (() => {})
  // MEMOISE BY QUERY. The scan is deterministic over a tree that does not change during a run, and
  // the live retrieval arm re-ran it for every rung of every plan attempt — measured at 3.2-5.2s a
  // time, a dozen-plus times per draw, all returning the identical five files. Caching is free
  // correctness-wise (same input, same output) and gives the rung its seconds back. Scoped to this
  // retriever instance, so a caller that wants a fresh scan makes a fresh one.
  const cache = new Map<string, string[] | null>()
  return async (query: string) => {
    const cached = cache.get(query)
    if (cached !== undefined) {
      emit({ type: 'thought', text: `local corpus: reusing the cached scan for this query (${cached ? cached.length : 0} file(s))` })
      return cached
    }
    const keywords = queryKeywords(query)
    if (keywords.length < 2) { emit({ type: 'thought', text: 'local corpus: query has too few keywords to rank on' }); cache.set(query, null); return null }
    const t0 = Date.now()
    const hits = scan(root, keywords, maxScanned)
    if (!hits.length) {
      emit({ type: 'thought', text: `local corpus: no file matched ${keywords.join('/')} (${Date.now() - t0}ms)` })
      cache.set(query, null)
      return null
    }
    const top = hits.slice(0, maxFiles)
    emit({ type: 'thought', text: `local corpus: ${top.length} file(s) for ${keywords.join('/')} in ${Date.now() - t0}ms — ${top.map(h => h.path.slice(root.length + 1)).join(', ')}` })
    // One blob per file: makeRetrievalProposer keeps same-named alternate implementations as
    // DISTINCT candidates that way, instead of collapsing them by first-wins name dedup.
    const blobs: string[] = []
    for (const h of top) {
      try { blobs.push(readFileSync(h.path, 'utf8').slice(0, maxBytes)) } catch { /* vanished mid-scan */ }
    }
    const out = blobs.length ? blobs : null
    cache.set(query, out)
    return out
  }
}

/**
 * What the shelf actually holds, for a bench header. A retrieval number is uninterpretable without
 * this: "retrieval solved the CSV rung" means one thing if the corpus has no CSV parser and the
 * opposite if it ships one. Printing it makes the contamination question a MEASUREMENT rather than
 * a claim in a comment — which is exactly the discipline the `_learned/` incident cost a session to
 * learn. Returns matching package names so the reader judges for themselves.
 */
export function describeCorpus(root: string, topic: RegExp, limit = 20): { packages: number; matches: string[] } {
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return { packages: 0, matches: [] } }
  const packages: string[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      try { for (const sub of readdirSync(join(root, name))) packages.push(`${name}/${sub}`) } catch { /* unreadable scope */ }
    } else packages.push(name)
  }
  return { packages: packages.length, matches: packages.filter(p => topic.test(p)).slice(0, limit) }
}
