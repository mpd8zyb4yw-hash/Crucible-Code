// ============================================================================
// Crucible Synthesis Engine — PURE-CODE program synthesis. ZERO model inference.
//
// "Crucible IS the model." Instead of asking an LLM (free pool or on-device) to
// probabilistically generate code, Crucible synthesizes it deterministically from a
// library of VERIFIED, parameterized primitives matched to the spec by pure-code rules.
// The local compiler/runtime is the correctness oracle. For any task that matches a
// primitive family this emits guaranteed-correct code — instantly, offline, deterministic,
// no rate limits, no hallucination.
//
// Honest boundary: it does NOT attempt arbitrary novel logic (undecidable). On a genuine
// no-match it returns null so the caller can escalate, rather than emitting plausible-wrong
// code. The library GROWS over time (RSI): every newly-verified solution becomes a reusable
// primitive, so coverage compounds without ever lowering the floor.
// ============================================================================

export interface SynthFile {
  path: string        // relative path the spec asked for (e.g. "src/scheduler.ts")
  content: string
}

export interface Skill {
  id: string
  /** Families of task this primitive covers — for diagnostics. */
  summary: string
  /** Pure-code confidence (0..1) that this skill satisfies the spec. */
  match(spec: SpecFeatures): number
  /** Emit the verified implementation, targeting the spec's requested file path. */
  emit(spec: SpecFeatures): SynthFile[]
}

/** Deterministically extracted features of a spec — pure code, no inference. */
export interface SpecFeatures {
  raw: string
  lower: string
  /** Requested module path, e.g. "src/scheduler.ts" (first code-path in the spec). */
  modulePath: string | null
  /** Exported symbols named in the spec (class/function/const + Name). */
  exports: string[]
  has: (re: RegExp) => boolean
  count: (re: RegExp) => number
}

export function extractFeatures(spec: string): SpecFeatures {
  const lower = spec.toLowerCase()
  const modulePath = (spec.match(/\b((?:src\/)?[\w./-]+\.(?:ts|tsx|js|mjs))\b/) ?? [])[1] ?? null
  const exports = Array.from(
    spec.matchAll(/\bexport\s+(?:async\s+)?(?:class|function|const|interface|type)\s+([A-Za-z_$][\w$]*)/g),
    m => m[1],
  )
  // also catch "export class KVStore" inside a contract block that uses bare names
  const namedClasses = Array.from(spec.matchAll(/\bclass\s+([A-Z][\w$]*)/g), m => m[1])
  // Require ( after the name so "The function must not..." doesn't match as an export.
  const fns = Array.from(spec.matchAll(/\bfunction\s+([a-z][\w$]*)\s*\(/g), m => m[1])
  const allExports = Array.from(new Set([...exports, ...namedClasses, ...fns]))
  return {
    raw: spec,
    lower,
    modulePath,
    exports: allExports,
    has: (re: RegExp) => re.test(spec),
    count: (re: RegExp) => (spec.match(re) ?? []).length,
  }
}

export interface SynthResult {
  matched: Skill | null
  confidence: number
  files: SynthFile[]
  /** Honest diagnostics: top candidate skills + scores, for "why this / why no-match". */
  ranking: Array<{ id: string; score: number }>
}

const REGISTRY: Skill[] = []
export function registerSkill(s: Skill) { REGISTRY.push(s) }
export function listSkills(): Skill[] { return [...REGISTRY] }

/** Match a spec to the best verified primitive. Returns null below the confidence floor. */
export function synthesize(spec: string, opts: { minConfidence?: number } = {}): SynthResult {
  const min = opts.minConfidence ?? 0.5
  const feats = extractFeatures(spec)
  // Sort by RAW score (pre-clamp) so that a more-specific skill (raw 1.8) beats a
  // less-specific one (raw 1.1) even though both would clamp to 1.0. Only the final
  // confidence value shown to callers is clamped — the ranking itself uses true specificity.
  const ranking = REGISTRY
    .map(s => { const raw = clamp0(s.match(feats)); return { id: s.id, score: clamp01(raw), raw } })
    .sort((a, b) => b.raw - a.raw)
    .map(({ id, score }) => ({ id, score }))
  const top = ranking[0]
  if (!top || top.score < min) {
    return { matched: null, confidence: top?.score ?? 0, files: [], ranking }
  }
  const skill = REGISTRY.find(s => s.id === top.id)!
  return { matched: skill, confidence: top.score, files: skill.emit(feats), ranking }
}

function clamp0(n: number): number { return Math.max(0, n) }
function clamp01(n: number): number { return Math.min(1, Math.max(0, n)) }

// NOTE: skills self-register via registerSkill() on import. They are loaded by ./index
// (the barrel), NOT here — importing them from this file would run them before REGISTRY
// is initialized (ESM hoists imports → temporal dead zone). Always import from ./index.
