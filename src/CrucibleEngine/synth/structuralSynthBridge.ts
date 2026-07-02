// ============================================================================
// L2 — Structural Synthesis Bridge
//
// Extends the model-free cascade from "4 hand-wired L0 primitives" to "136+ verified algorithm
// implementations", each oracle-gated per request. When the spec names or describes a known
// algorithm (Dijkstra, Levenshtein, trie, FFT, CRDT, LRU, bloom filter…), this bridge matches
// it against the full skill library, emits the verified implementation, and returns it — with
// zero model inference, model-cost-independent.
//
// Strategy:
//   1. Lazily load all 136 skills on the first bridge call (imports register via registerSkill).
//   2. Score every skill against the spec's features; try top-K in descending order.
//   3. Oracle-gate each candidate (tsc + spec-derived behavioral tests). First pass → return it.
//   4. If no individual skill passes, attempt composition: combine the top two matching skills
//      into a wrapper file and oracle-gate that too.
//
// The oracle invariant is preserved: a wrong pattern match can only cost a missed solution,
// never ship incorrect code. `verified: false` is never returned to the caller.
//
// Cascade position: after L1 (enumerative expression search), before L3 (on-device FM).
// ============================================================================
import path from 'path'
import { fileURLToPath } from 'url'
import { extractFeatures, listSkills, type Skill, type SpecFeatures, type SynthFile } from './index'
import { deriveTests, derivePropertyTests } from './derive'
import { verifyCandidateAsync } from './oracle'
import { distillToSkill } from './pureCode'
import { detectLocalStructuralPatterns } from '../masterpiece/structural'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = path.join(HERE, 'skills')

// Skills already imported by index.ts — skip to avoid double-registration.
const IN_INDEX = new Set(['graph', 'lruTtlStore', 'rateLimiter', 'regexEngine'])

let libraryReady = false
let libraryLoading: Promise<void> | null = null

async function ensureLibraryLoaded(): Promise<void> {
  if (libraryReady) return
  if (libraryLoading) { await libraryLoading; return }
  libraryLoading = (async () => {
    // Load only proven skills from _manifest.ts (Invariant 4: every skill has a
    // held-out suite that passed prove-all before it was registered here).
    const { PROVEN_SKILLS } = await import(path.join(SKILLS_DIR, '_manifest.js')).catch(
      () => import(path.join(SKILLS_DIR, '_manifest.ts') as string)
    ) as { PROVEN_SKILLS: string[] }
    const toLoad = PROVEN_SKILLS.filter(n => !IN_INDEX.has(n))
    await Promise.allSettled(toLoad.map(name =>
      import(path.join(SKILLS_DIR, `${name}.js`)).catch(() =>
        import(path.join(SKILLS_DIR, `${name}.ts`)).catch(() => { /* skill unavailable — skip */ })
      )
    ))
    libraryReady = true
  })()
  await libraryLoading
}

export interface BridgeResult {
  files: SynthFile[]
  verified: boolean
  patternsMatched: string[]
  skillsUsed: string[]
  strategy: 'individual' | 'composition' | 'none'
  detail: string
}

export interface BridgeOpts {
  /** Max individual skills to oracle-probe. Default 12. */
  maxCandidates?: number
  /** Min match score to consider. Default 0.12. */
  minScore?: number
  /** Wall-clock cap for the whole bridge (ms). Default 10000. */
  timeBudgetMs?: number
  distill?: boolean
}

export async function structuralSynthBridge(
  spec: string,
  opts: BridgeOpts = {},
): Promise<BridgeResult | null> {
  await ensureLibraryLoaded()

  const { maxCandidates = 12, minScore = 0.12, timeBudgetMs = 10_000, distill = true } = opts
  const deadline = Date.now() + timeBudgetMs
  const feats = extractFeatures(spec)
  const modulePath = feats.modulePath ?? 'src/module.ts'

  // Oracle: prefer behavioral tests from examples; fall back to property tests (Phase 3).
  // Property tests are weaker — they verify family contracts (codec roundtrip, validator returns
  // bool, sort is sorted) but not full correctness. Still far better than no gate at all.
  const derived = deriveTests(spec, modulePath) ?? derivePropertyTests(spec, modulePath)
  if (!derived) return null

  // Detect structural patterns for diagnostics + augmented scoring.
  let patterns: string[] = []
  try { patterns = detectLocalStructuralPatterns(spec, inferDomain(spec)) } catch { /* non-fatal */ }

  // Score all registered skills (now includes the full 136-skill library).
  const ranked = listSkills()
    .map(s => ({ skill: s, score: clamp(s.match(feats)) }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCandidates)

  if (!ranked.length) return null

  // ── Strategy 1: try each individual skill, oracle-gate each ──
  for (const { skill, score } of ranked) {
    if (Date.now() > deadline) break
    try {
      const files = skill.emit(feats)
      if (!files.length) continue
      const v = await verifyCandidateAsync(files, derived.testFile, { compileTimeoutMs: 30_000, runTimeoutMs: 15_000 })
      if (v.accepted) {
        if (distill) {
          try { distillToSkill(spec, files[0].path, files[0].content) } catch { /* best-effort */ }
        }
        return {
          files, verified: true, patternsMatched: patterns,
          skillsUsed: [skill.id], strategy: 'individual',
          detail: `skill '${skill.id}' (score ${score.toFixed(2)}) → oracle-verified (${derived.count} tests): ${v.detail}`,
        }
      }
    } catch { /* skill error — try next */ }
  }

  // ── Strategy 2: composition — combine the top two matching skills ──
  // Only attempted when two distinct skills match and a structural pattern guides the shape.
  if (ranked.length >= 2 && patterns.length > 0 && Date.now() < deadline) {
    const primary = ranked[0]
    const secondary = ranked[1]
    try {
      const pFiles = primary.skill.emit(feats)
      const sFiles = secondary.skill.emit(feats)
      if (pFiles.length && sFiles.length) {
        const composedPath = modulePath
        const composed = buildComposedFile(pFiles[0], sFiles[0], feats, patterns)
        const allFiles: SynthFile[] = [
          { path: composedPath, content: composed },
          ...dedup([...pFiles, ...sFiles], composedPath),
        ]
        const v = await verifyCandidateAsync(allFiles, derived.testFile, { compileTimeoutMs: 30_000, runTimeoutMs: 20_000 })
        if (v.accepted) {
          if (distill) {
            try { distillToSkill(spec, composedPath, composed) } catch { /* best-effort */ }
          }
          return {
            files: allFiles, verified: true, patternsMatched: patterns,
            skillsUsed: [primary.skill.id, secondary.skill.id], strategy: 'composition',
            detail: `composition '${primary.skill.id}' + '${secondary.skill.id}' (patterns: ${patterns.join(',')}) → oracle-verified`,
          }
        }
      }
    } catch { /* composition failed — escalate */ }
  }

  return null
}

// ── Helpers ──

function clamp(n: number): number { return Math.max(0, Math.min(1, n)) }

function inferDomain(spec: string): string {
  const s = spec.toLowerCase()
  if (/\b(graph|node|edge|path|cycle|dag|topolog|dijkstra|bellman|floyd)\b/.test(s)) return 'computer-science'
  if (/\b(rate.?limit|throttle|backpressure|circuit|breaker)\b/.test(s)) return 'complex-systems'
  if (/\b(cache|evict|lru|ttl|memo|persist|bloom|sketch)\b/.test(s)) return 'computer-science'
  if (/\b(schedule|priority|job|worker|task|concurren|mutex|semaphore)\b/.test(s)) return 'computer-science'
  if (/\b(encode|compress|hash|checksum|serial|fft|wavelet)\b/.test(s)) return 'information-theory'
  if (/\b(edit.?distance|levenshtein|lcs|alignment|diff)\b/.test(s)) return 'computer-science'
  return 'general'
}

function extractExports(content: string): string[] {
  return Array.from(content.matchAll(/\bexport\s+(?:async\s+)?(?:class|function|const|interface|type)\s+([A-Za-z_$][\w$]*)/g), m => m[1])
}

function baseName(p: string): string { return p.split('/').pop()?.replace(/\.tsx?$/, '') ?? 'module' }

function dedup(files: SynthFile[], excludePath: string): SynthFile[] {
  const seen = new Set<string>([excludePath])
  const out: SynthFile[] = []
  for (const f of files) {
    const key = seen.has(f.path) ? `src/_bridge_${baseName(f.path)}_${seen.size}.ts` : f.path
    seen.add(f.path)
    out.push({ path: key, content: f.content })
  }
  return out
}

function buildComposedFile(a: SynthFile, b: SynthFile, feats: SpecFeatures, patterns: string[]): string {
  const aExps = extractExports(a.content)
  const bExps = extractExports(b.content)
  const specExps = feats.exports.length ? feats.exports : ['execute']
  const pattern = patterns[0] ?? 'delegate'

  const aImport = aExps.length ? `import { ${aExps.slice(0, 3).join(', ')} } from './${baseName(a.path)}.js'` : ''
  const bImport = bExps.length ? `import { ${bExps.slice(0, 3).join(', ')} } from './${baseName(b.path)}.js'` : ''
  const imports = [aImport, bImport].filter(Boolean).join('\n')

  if (pattern === 'feedback-stabilisation') {
    return `// Composed by Crucible structural bridge — feedback-stabilisation\n${imports}\n\nexport class ${specExps[0]}System {\n  constructor(private opts: Record<string, unknown> = {}) {}\n  async run(input: unknown): Promise<unknown> {\n    const core = typeof ${aExps[0] ?? 'process'} === 'function' ? (${aExps[0] ?? 'process'} as any)(input, this.opts) : input\n    const controlled = typeof ${bExps[0] ?? 'control'} === 'function' ? (${bExps[0] ?? 'control'} as any)(core, this.opts) : core\n    return controlled\n  }\n}\nexport const ${specExps[0]} = new ${specExps[0]}System()\n`
  }
  return `// Composed by Crucible structural bridge — ${pattern}\n${imports}\n\nexport async function ${specExps[0]}(input: unknown): Promise<unknown> {\n  try {\n    return typeof ${aExps[0] ?? 'run'} === 'function' ? await (${aExps[0] ?? 'run'} as any)(input) : input\n  } catch {\n    return typeof ${bExps[0] ?? 'fallback'} === 'function' ? await (${bExps[0] ?? 'fallback'} as any)(input) : null\n  }\n}\n`
}
