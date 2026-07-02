// ============================================================================
// The pure-code ENUMERATIVE proposer (L1) — reasons about a NOVEL coding task with ZERO model
// inference, by bottom-up program search over the typed DSL (dsl.ts).
//
// How it "reasons":
//   1. parse the spec's worked examples into concrete (args → output) pairs;
//   2. seed a pool with the parameters and a small constant set (each carries its value-vector
//      across all examples + the TS source that produces it + an eval closure);
//   3. enumerate expressions of increasing SIZE, applying DSL operators to pool members whose
//      types fit; for each candidate, evaluate its value-vector across the examples;
//   4. OBSERVATIONAL-EQUIVALENCE pruning: two expressions with identical value-vectors are
//      interchangeable — keep only the first (smallest), which keeps the search tractable;
//   5. a candidate whose value-vector equals the target outputs on EVERY example is a solution;
//   6. AMBIGUITY GUARD: collect every solution at the minimal size, then probe each against
//      auto-generated inputs. If two equally-simple programs both satisfy the examples but
//      disagree on a probe, the spec is UNDER-SPECIFIED — escalate honestly rather than ship a
//      coin-flip. Otherwise emit the smallest solution (Occam: simpler ⇒ generalizes better).
//
// This is classic example-driven (PBE) bottom-up synthesis (à la Bustle/TF-Coder). It is
// deterministic, offline, model-free, and — crucially — its output is still handed to the
// execution oracle by the caller, so a search bug can only miss a solution, never ship a wrong
// one. It slots strictly between L0 (exact primitive) and L3 (on-device FM) in the cascade.
// ============================================================================
import { extractFeatures, type SynthFile } from '../synthEngine'
import { parseIoExamples, type Signature } from './examples'
import { OPS, tagOf, tsType, slotAccepts, extractConstants, type Tag } from './dsl'

type EvalFn = (args: unknown[]) => unknown

interface Val {
  code: string
  vec: unknown[]
  tag: Tag
  size: number
  usesInput: boolean
  ev: EvalFn           // evaluate this expression on an arbitrary argument tuple (for probes)
}

export interface EnumResult {
  files: SynthFile[]
  fnName: string
  expr: string
  size: number
  examplesUsed: number
  nodesExplored: number
  detail: string
}

export type EnumOutcome =
  | { status: 'solved'; result: EnumResult }
  | { status: 'none'; detail: string }
  | { status: 'ambiguous'; detail: string; candidates: string[] }

export interface EnumOpts {
  maxSize?: number       // largest expression size to enumerate (default 4)
  maxPool?: number       // cap on distinct (obs-equiv) values kept (default 12000)
  timeBudgetMs?: number  // wall-clock cap (default 3000)
  modulePath?: string    // override the emitted file path
}

// Full set of words that cannot be used as a parameter identifier in TS output. A signature
// param hitting any of these (or not being a plain identifier) triggers the fabricated-name
// fallback in resolveParams, so codegen never emits an uncompilable parameter list.
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'async', 'implements', 'interface',
  'package', 'private', 'protected', 'public',
])
const IDENT = /^[A-Za-z_$][\w$]*$/

/** Convenience wrapper: the emitted file on a confident solve, else null (none/ambiguous). */
export function synthesizeEnumerative(spec: string, opts: EnumOpts = {}): EnumResult | null {
  const o = enumerate(spec, opts)
  return o.status === 'solved' ? o.result : null
}

/** Full outcome: 'solved' | 'none' (no program) | 'ambiguous' (spec under-specifies). */
export function enumerate(spec: string, opts: EnumOpts = {}): EnumOutcome {
  const parsed = parseIoExamples(spec)
  if (!parsed || parsed.arity === 0 || !parsed.examples.length) return { status: 'none', detail: 'no usable worked examples' }
  const { fnName, arity, examples, signature } = parsed
  const nEx = examples.length
  const maxSize = opts.maxSize ?? 4
  const maxPool = opts.maxPool ?? 12000
  const deadline = Date.now() + (opts.timeBudgetMs ?? 3000)

  const outputs = examples.map(e => e.output)
  const targetTag = tagOf(outputs)
  if (targetTag === null) return { status: 'none', detail: 'output shape not modeled by the DSL' }
  const targetJson = JSON.stringify(outputs)

  const params = resolveParams(signature, arity, examples)
  const inputTags: Tag[] = []
  const inputs: Val[] = []
  const presentTags = new Set<Tag>([targetTag])
  for (let i = 0; i < arity; i++) {
    const vec = examples.map(e => e.args[i])
    const tag = tagOf(vec)
    if (tag === null) return { status: 'none', detail: `argument ${i} has a type not modeled by the DSL` }
    presentTags.add(tag)
    inputTags.push(tag)
    inputs.push({ code: params[i].name, vec, tag, size: 1, usesInput: true, ev: (args) => args[i] })
  }
  const probes = probeInputs(inputTags)

  // Search state — declared BEFORE the identity fast-path because solved() reads `nodes`
  // (a `let` in temporal dead zone until initialized would crash an identity/projection solve).
  const solutions: Val[] = []
  let ambiguous: { a: string; b: string } | null = null
  let nodes = 0

  // Identity / projection: a parameter already equals the output on every example.
  for (const v of inputs) if (JSON.stringify(v.vec) === targetJson) return solved(v)

  const consts: Val[] = extractConstants(spec, presentTags).map(c => ({
    code: c.code, vec: examples.map(() => c.value), tag: c.tag, size: 1, usesInput: false, ev: () => c.value,
  }))

  const bySizeTag = new Map<string, Val[]>()
  const seen = new Set<string>()
  let pool = 0
  const add = (v: Val): void => {
    const key = `${v.tag}::${JSON.stringify(v.vec)}`
    if (seen.has(key)) return
    seen.add(key)
    const sk = `${v.size}|${v.tag}`
    if (!bySizeTag.has(sk)) bySizeTag.set(sk, [])
    bySizeTag.get(sk)!.push(v)
    pool++
  }
  for (const v of [...inputs, ...consts]) add(v)
  const bucketsBySize = (size: number): Val[] => {
    const out: Val[] = []
    for (const [k, vs] of bySizeTag) if (k.startsWith(`${size}|`)) out.push(...vs)
    return out
  }

  outer:
  for (let size = 2; size <= maxSize; size++) {
    for (const op of OPS) {
      if (op.in.length === 1) {
        for (const a of bucketsBySize(size - 1)) {
          if (!slotAccepts(op.in[0], a.tag)) continue
          const v = apply1(op, a, examples, size); nodes++
          if (!v) continue
          if (isSolution(v, targetJson)) { record(v); if (ambiguous) break outer; continue }
          add(v)
          if (pool > maxPool || Date.now() > deadline) break outer
        }
      } else {
        for (let i = 1; i <= size - 2; i++) {
          const j = size - 1 - i
          if (j < 1) continue
          for (const a of bucketsBySize(i)) {
            if (!slotAccepts(op.in[0], a.tag)) continue
            for (const b of bucketsBySize(j)) {
              if (!slotAccepts(op.in[1], b.tag)) continue
              const v = apply2(op, a, b, examples, size); nodes++
              if (!v) continue
              if (isSolution(v, targetJson)) { record(v); if (ambiguous) break outer; continue }
              add(v)
              if (pool > maxPool || Date.now() > deadline) break outer
            }
          }
        }
      }
    }
    if (solutions.length) break        // finished the minimal-solution size — decide below
    if (Date.now() > deadline) break
  }

  if (ambiguous) {
    return {
      status: 'ambiguous',
      detail: `examples under-specify ${fnName}: two equally-simple programs agree on all ${nEx} example(s) but differ on generated inputs — '${ambiguous.a}' vs '${ambiguous.b}'. Add a disambiguating example or escalate.`,
      candidates: solutions.map(s => s.code),
    }
  }
  if (!solutions.length) return { status: 'none', detail: `no expression ≤ size ${maxSize} fits the examples (${nodes} nodes explored)` }
  return solved(solutions[0])

  // ── closures over search state ──
  function isSolution(v: Val, target: string): boolean {
    return v.usesInput && JSON.stringify(v.vec) === target
  }
  function record(v: Val): void {
    for (const s of solutions) {
      if (probeDiverge(s.ev, v.ev, probes)) { ambiguous = { a: s.code, b: v.code }; break }
    }
    solutions.push(v)
  }
  function solved(v: Val): EnumOutcome {
    const modulePath = opts.modulePath ?? extractFeatures(spec).modulePath ?? `src/${fnName}.ts`
    const retType = (signature?.ret && /^[\w<>\[\]| ]+$/.test(signature.ret)) ? signature.ret.trim() : tsType(targetTag!)
    const sig = params.map(p => `${p.name}: ${p.type}`).join(', ')
    const content = `// Synthesized by Crucible (pure-code enumerative search — ZERO model inference).
// Found by bottom-up program search over a typed DSL, consistent with ${nEx} worked example(s)
// and confirmed unambiguous against generated probe inputs, then verified by the execution
// oracle. Expression size ${v.size}.
export function ${fnName}(${sig}): ${retType} {
  return ${v.code}
}
`
    return {
      status: 'solved',
      result: { files: [{ path: modulePath, content }], fnName, expr: v.code, size: v.size, examplesUsed: nEx, nodesExplored: nodes, detail: `found ${fnName} = ${v.code} (size ${v.size}, ${nEx} examples, ${nodes} nodes)` },
    }
  }
}

function apply1(op: (typeof OPS)[number], a: Val, examples: { args: unknown[]; output: unknown }[], size: number): Val | null {
  if (!op.out([a.tag])) return null
  const vec: unknown[] = new Array(examples.length)
  for (let e = 0; e < examples.length; e++) {
    try { vec[e] = op.ev(a.vec[e]) } catch { return null }
  }
  const tag = tagOf(vec)
  if (tag === null) return null
  return { code: op.code(a.code), vec, tag, size, usesInput: a.usesInput, ev: (args) => op.ev(a.ev(args)) }
}

function apply2(op: (typeof OPS)[number], a: Val, b: Val, examples: { args: unknown[]; output: unknown }[], size: number): Val | null {
  if (!op.out([a.tag, b.tag])) return null
  const vec: unknown[] = new Array(examples.length)
  for (let e = 0; e < examples.length; e++) {
    try { vec[e] = op.ev(a.vec[e], b.vec[e]) } catch { return null }
  }
  const tag = tagOf(vec)
  if (tag === null) return null
  return { code: op.code(a.code, b.code), vec, tag, size, usesInput: a.usesInput || b.usesInput, ev: (args) => op.ev(a.ev(args), b.ev(args)) }
}

// ── Ambiguity probing: do two programs that both satisfy the examples disagree on any
//    auto-generated input of the right types? Throwing probes (partial domains) are skipped. ──
const PROBE_BANK: Record<Tag, unknown[]> = {
  'num': [0, 1, -1, 2, 7, -3, 5, 12],
  'str': ['', 'a', 'ab', 'abc', 'noon', 'Hello', 'xy', 'level'],
  'num[]': [[], [1], [2, 1], [1, 2, 3], [3, 1, 2, 3, 1], [-2, 0, 3], [5, 5], [4, 2, 7, 1]],
  'str[]': [['a'], [], ['b', 'a'], ['x', 'y'], ['a', 'a'], ['c', 'b', 'a']],
  'bool': [true, false, true, false],
}
const N_PROBES = 8

function probeInputs(tags: Tag[]): unknown[][] {
  return Array.from({ length: N_PROBES }, (_, i) => tags.map(t => {
    const bank = PROBE_BANK[t]
    return clone(bank[i % bank.length])
  }))
}
function clone<T>(v: T): T { return (typeof v === 'object' && v !== null) ? JSON.parse(JSON.stringify(v)) : v }

function probeDiverge(ev1: EvalFn, ev2: EvalFn, probes: unknown[][]): boolean {
  for (const p of probes) {
    let r1: unknown, r2: unknown
    try { r1 = ev1(clone(p)) } catch { continue }
    try { r2 = ev2(clone(p)) } catch { continue }
    if (JSON.stringify(r1) !== JSON.stringify(r2)) return true
  }
  return false
}

/** Param names/types: prefer the spec's signature; otherwise fabricate from the example arg types. */
function resolveParams(sig: Signature | null, arity: number, examples: { args: unknown[] }[]): { name: string; type: string }[] {
  if (sig && sig.params.length === arity && sig.params.every(p => p.name && IDENT.test(p.name) && !RESERVED.has(p.name))) {
    return sig.params.map(p => ({ name: p.name, type: p.type && p.type !== 'any' ? p.type : 'any' }))
  }
  return Array.from({ length: arity }, (_, i) => {
    const tag = tagOf(examples.map(e => e.args[i]))
    return { name: String.fromCharCode(97 + i), type: tag ? tsType(tag) : 'any' }
  })
}
