// ============================================================================
// The PURE-CODE cascade — L0 (exact primitive) → L1 (enumerative search) — with ZERO model
// inference of any kind (no free pool, no on-device FM). This is the part of the universal
// cascade that runs in the live server fast-path: it either ships oracle-verified pure code,
// instantly and model-cost-independent, or returns null so the caller escalates (to L3 FM, or the agent
// loop). `synthesizeUniversal` reuses this and appends L3 on top.
//
//   L0  exact primitive            — a registered, library-verified Skill emits a whole module.
//   L1  enumerative search         — bottom-up program synthesis from the spec's worked examples,
//                                     gated by the execution oracle, then DISTILLED into a learned
//                                     pure-code Skill so the next identical task skips the search.
//
// Every L1 win is re-verified by the oracle before it is returned, so a search bug can only
// cost a missed solution — never ship wrong code. The floor never lowers.
// ============================================================================
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { synthesize, extractFeatures, registerSkill, listSkills, type SynthFile } from './index'
import { deriveTests, derivePropertyTests } from './derive'
import { verifyCandidate, verifyCandidateAsync } from './oracle'
import { synthesizeEnumerative } from './proposers/enumerative'
import { ensureLibraryLoaded } from './loadLibrary'
import { buildRepoContext, enrichSpec, type OracleContextFile } from './repoContext'

export interface PureCodeResult {
  files: SynthFile[]
  source: 'primitive' | 'enumerative' | null
  verified: boolean
  testsDerived: number
  detail: string
  skillId: string | null
}

export interface PureCodeOpts {
  minConfidence?: number
  distill?: boolean              // register a learned Skill from an L1 win (default true)
  enumerate?: boolean            // run L1 at all (default true)
  enumTimeBudgetMs?: number      // L1 search wall-clock cap
  verify?: 'sync' | 'async'      // oracle flavor (default 'async'; prove harnesses pass 'sync')
  projectPath?: string           // Phase C: project root for repo-context enrichment + oracle typing
}

/**
 * Run the no-model cascade. Resolves to a verified pure-code result, or a null-source result
 * meaning "no pure-code solution — escalate". Never invokes any model.
 */
export async function synthesizePureCode(spec: string, opts: PureCodeOpts = {}): Promise<PureCodeResult> {
  // Phase C: enrich spec with repo context when a project is known.
  let enrichedSpec = spec
  let contextFiles: OracleContextFile[] = []
  if (opts.projectPath) {
    try {
      const rawFeats = extractFeatures(spec)
      const ctx = buildRepoContext(opts.projectPath, spec, rawFeats.modulePath)
      enrichedSpec = enrichSpec(spec, ctx)
      contextFiles = ctx.oracleFiles
    } catch { /* repo context is best-effort */ }
  }

  const feats = extractFeatures(enrichedSpec)
  const modulePath = feats.modulePath ?? 'src/module.ts'
  const derived = deriveTests(enrichedSpec, modulePath)
  const testsDerived = derived?.count ?? 0
  const verifyOpts = { contextFiles, projectPath: opts.projectPath }
  const verify = opts.verify === 'sync'
    ? (f: SynthFile[], t?: SynthFile) => Promise.resolve(verifyCandidate(f, t, verifyOpts))
    : (f: SynthFile[], t?: SynthFile) => verifyCandidateAsync(f, t, verifyOpts)

  // ── L0: exact primitive (instant). Re-verify against derived tests if the spec pins any down. ──
  const prim = synthesize(spec, { minConfidence: opts.minConfidence })
  if (prim.matched) {
    // CERTIFICATION-SCOPE SOUNDNESS (2026-07-22): a catalog GREEN is only honest if the emitted
    // deliverable IS the one the request (and any external audit) will import — the EXACT export
    // names AT the declared module path. A keyword-matched primitive that lands at its own default
    // path, or exports a near-neighbour name, passes behavior yet fails the audit's
    // `import { rotate90 } from '../src/matrixRotate'` with "rotate90 is not a function". So every
    // L0 ship below is now gated on identity (path + declared-export superset), not just behavior.
    const identityOK = satisfiesRequestedIdentity(prim.files, feats.exports, feats.modulePath)
    if (derived) {
      // Behavioral ground truth exists. It must pass AND the deliverable's identity must match the
      // request — a primitive whose behavior satisfies the derived cases but whose file lands at
      // the wrong path (so the audit imports an absent module) is NOT a certified solve.
      const v = await verify(prim.files, derived.testFile)
      if (v.accepted && identityOK) return ok(prim.files, 'primitive', testsDerived, `primitive ${prim.matched.id} ✓ ${testsDerived} derived tests, identity-matched`, prim.matched.id)
      // wrong behavior OR wrong identity → fall through to enumerative search
    } else if (feats.exports.length > 0 && identityOK) {
      // No behavioral test to re-run, but the spec pins an API and the primitive emits exactly it
      // at the declared path. A keyword+shape hit alone is NOT proof of THIS spec's semantics
      // (measured: a `deepEqual` primitive shipping GREEN for a `deepEqualCyc` request that needs
      // cycle handling; a `posixResolve` catalog hit failing 14 hidden edge cases). So before
      // claiming a verified GREEN, try to derive a PROPERTY family from the spec and gate on it —
      // family-contract behavior (roundtrip, sorted-permutation, clamp bounds…) is real ground
      // truth, no examples required. Only ship shape-only when NO property family is derivable
      // (the honest floor: a library-verified primitive matching the declared API exactly).
      const propTests = derivePropertyTests(spec, modulePath)
      if (propTests) {
        const v = await verify(prim.files, propTests.testFile)
        if (v.accepted) return ok(prim.files, 'primitive', propTests.count, `primitive ${prim.matched.id} ✓ ${propTests.count} ${propTests.family} property checks, identity-matched`, prim.matched.id)
        // primitive fails this spec's property contract → fall through, escalate honestly
      } else {
        // The synth-side families (derivePropertyTests) missed, but the VGR-side SUPPLEMENTAL
        // families (~30: recurrences, reference derivations, roundtrips) cover many names synth
        // does not. Cross-check the L0 catalog ship against them before falling back to the
        // shape-only floor. Lazy import breaks the synth→reasoning→synth module cycle at load time
        // (propertyVerifier statically imports this package). A matched family that PASSES lifts the
        // ship from shape-only to behavior-verified; a matched family that FAILS forces an honest
        // escalation (the primitive is the wrong semantics for THIS spec); no match → shape floor.
        const suppVerdict = await verifyAgainstSupplemental(prim.files, feats.exports)
        if (suppVerdict === 'pass') return ok(prim.files, 'primitive', 1, `primitive ${prim.matched.id} ✓ supplemental invariant family, identity-matched`, prim.matched.id)
        if (suppVerdict === 'fail') {
          // fall through to L1/L2 — the catalog hit violates a real invariant, so escalate honestly
        } else {
          return ok(prim.files, 'primitive', 0, `primitive ${prim.matched.id} (library-verified, identity-matched; no example/property gate available)`, prim.matched.id)
        }
      }
    }
    // no declared exports, identity mismatch, or failed gate — fall through to L1/L2
  }

  // ── L1: pure-code enumerative search. Needs derivable behavioral tests to be oracle-gated. ──
  if (opts.enumerate !== false && derived) {
    try {
      const enr = synthesizeEnumerative(spec, { modulePath, timeBudgetMs: opts.enumTimeBudgetMs })
      if (enr) {
        const v = await verify(enr.files, derived.testFile)
        if (v.accepted) {
          if (opts.distill !== false) distillToSkill(spec, enr.files[0].path, enr.files[0].content)
          return ok(enr.files, 'enumerative', testsDerived, `enumerative search ${enr.detail} → oracle-verified (${testsDerived} tests)`, 'enumerative-search')
        }
      }
    } catch { /* enumerator failure is non-fatal — fall through to escalate */ }
  }

  // ── L2: Structural synthesis bridge — compositional generalization ──
  try {
    const { structuralSynthBridge } = await import('./structuralSynthBridge.js')
    const br = await structuralSynthBridge(spec, { distill: opts.distill !== false })
    if (br && br.verified && br.files.length) {
      return { files: br.files, source: 'enumerative', verified: true, testsDerived, detail: `structural bridge: ${br.detail}`, skillId: br.skillsUsed.join('+') }
    }
  } catch { /* bridge failure is non-fatal — escalate */ }

  return { files: [], source: null, verified: false, testsDerived, detail: 'no pure-code solution (no matching primitive; no enumerative program; no structural composition)', skillId: null }
}

function ok(files: SynthFile[], source: 'primitive' | 'enumerative', testsDerived: number, detail: string, skillId: string): PureCodeResult {
  return { files, source, verified: true, testsDerived, detail, skillId }
}

/**
 * Cross-check an L0 primitive against the VGR-side SUPPLEMENTAL invariant families (the same
 * ~30 exact-name-gated families the reasoning loop's W20 co-gate trusts). Returns:
 *   'pass' — a declared export matched a family AND its assertions held (behavior-verified)
 *   'fail' — a declared export matched a family but its assertions were VIOLATED (escalate honestly)
 *   'none' — no declared export matched any supplemental family (fall back to the shape-only floor)
 * Imported lazily so synth/pureCode → reasoning/propertyVerifier → synth/index is not a static
 * cycle. Any loader/probe error is swallowed as 'none' — the co-gate can only ADD confidence, never
 * regress the existing shape-only ship.
 */
export async function verifyAgainstSupplemental(files: SynthFile[], exports: string[]): Promise<'pass' | 'fail' | 'none'> {
  if (!files.length || !exports.length) return 'none'
  try {
    const { propertyForFunction, verifyByProperty } = await import('../reasoning/propertyVerifier.js')
    let matchedAny = false
    for (const entry of exports) {
      const spec = propertyForFunction(entry)
      if (!spec) continue
      matchedAny = true
      // Pass the file that actually exports this entry (else the first file) as the candidate body;
      // verifyByProperty concatenates it with an in-scope assertion harness.
      const host = files.find(f => new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|class)\\s+${entry}\\b`).test(f.content)) ?? files[0]
      const verdict = await verifyByProperty(
        { value: host.content, fingerprint: 'l0-supp' },
        { goal: '', domain: 'code', acceptance: { entry: spec.entry, family: spec.family, assertions: spec.assertions } } as any,
      )
      if (!verdict.pass) return 'fail'   // any matched family that fails is a hard escalation signal
    }
    return matchedAny ? 'pass' : 'none'
  } catch {
    return 'none'
  }
}

/**
 * Turn a verified candidate into a registered pure-code Skill so the next identical task is
 * model-free AND search-free (an instant L0 hit). In-process only — a learned skill never lowers
 * the verified floor because it is matched by exact requested-export set, and the live server
 * still re-confirms via the oracle. (Durable persistence under skills/_learned/ + a monotonic
 * synth:prove regate is the follow-up; kept off the hot path by design.)
 */
// ── Export-shape helpers (Phase-0 guard) ─────────────────────────────────────────────────

/** Extract the names of every explicitly-exported symbol from a TypeScript source string. */
function emittedExportNames(content: string): string[] {
  return Array.from(
    content.matchAll(/\bexport\s+(?:async\s+)?(?:class|function|const|interface|type)\s+([A-Za-z_$][\w$]*)/g),
    m => m[1],
  )
}

/**
 * True when the emitted files collectively export every name that the spec declared.
 * If the spec declared no explicit exports (empty requested set) this trivially passes —
 * no declared contract to violate.
 */
function satisfiesExportShape(files: SynthFile[], requested: string[]): boolean {
  if (!requested.length) return true
  const emitted = new Set(files.flatMap(f => emittedExportNames(f.content)))
  return requested.every(e => emitted.has(e))
}

/** Normalize a module path for identity comparison — strip a leading "./" and the code
 *  extension so `src/matrixRotate.ts` and `src/matrixRotate` (as the audit imports it) match. */
function normModulePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\.(?:tsx?|jsx?|mjs|cjs)$/, '')
}

/**
 * True when the emitted file set is the deliverable the REQUEST asked for — the certification
 * scope must equal the audit's import target, not merely be behaviourally similar:
 *   (a) every declared export name is emitted (superset — extra helpers are fine), AND
 *   (b) when the spec declares a module path, some emitted file lands at exactly that path.
 * If the spec declares no path (loose prose) the path clause is vacuous — behavior/shape alone
 * governs, as before. This is what stops a keyword-matched primitive from shipping GREEN at its
 * own default path while the audit imports an absent module ("rotate90 is not a function").
 */
function satisfiesRequestedIdentity(files: SynthFile[], requested: string[], modulePath: string | null): boolean {
  if (!satisfiesExportShape(files, requested)) return false
  if (!modulePath) return true
  const want = normModulePath(modulePath)
  return files.some(f => normModulePath(f.path) === want)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LEARNED_DIR = path.join(HERE, 'skills', '_learned')

/**
 * Content-addressed skill ID — sha256(spec + content) truncated to 12 hex chars.
 * Eliminates the basename-collision bug where two different specs emitting 'utils.ts'
 * would silently drop the second win. The ID is stable across restarts for the same content.
 */
function contentAddressedId(spec: string, content: string): string {
  return createHash('sha256').update(spec + '\x00' + content).digest('hex').slice(0, 12)
}

export function distillToSkill(spec: string, modulePath: string, content: string): void {
  const feats = extractFeatures(spec)
  const exports = feats.exports
  const hash = contentAddressedId(spec, content)
  const id = `learned/${hash}`
  if (listSkills().some(s => s.id === id)) return

  // In-memory registration for the current process
  registerSkill({
    id,
    summary: `Learned (distilled, oracle-verified) primitive exporting ${exports.join(', ') || modulePath}.`,
    match: (s) => {
      if (!exports.length) return 0
      const hit = exports.filter(e => s.has(new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`))).length
      return hit / exports.length
    },
    emit: (s) => [{ path: s.modulePath ?? modulePath, content }],
  })

  // Durable persistence — survives restart. Loaded by loadLibrary at next boot.
  // File name is the content hash, so two different wins with the same module basename
  // both persist independently instead of the second silently clobbering the first.
  try {
    fs.mkdirSync(LEARNED_DIR, { recursive: true })
    const destPath = path.join(LEARNED_DIR, `${hash}.ts`)
    if (fs.existsSync(destPath)) return   // already persisted (same content, same spec)

    const contentLiteral = JSON.stringify(content)
    const defaultPath = JSON.stringify(modulePath)
    // Generate one regex per export name (avoids complex escaping in template literals)
    const matchLines = exports.length === 0
      ? '    return 0'
      : [
          `    let hits = 0`,
          ...exports.map(e => `    if (s.has(/\\b${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b/)) hits++`),
          `    return hits / ${exports.length}`,
        ].join('\n')
    const skillFile = [
      `// Auto-distilled by Crucible — oracle-verified at distillation time. Do not edit.`,
      `// Content-addressed ID: ${hash} (sha256 of spec+content, first 12 hex chars).`,
      `import { registerSkill, type SpecFeatures } from '../../synthEngine'`,
      ``,
      `const IMPL: string = ${contentLiteral}`,
      `const DEFAULT_PATH: string = ${defaultPath}`,
      ``,
      `registerSkill({`,
      `  id: ${JSON.stringify(id)},`,
      `  summary: ${JSON.stringify(`Learned (distilled, oracle-verified) primitive exporting ${exports.join(', ') || modulePath}.`)},`,
      `  match(s: SpecFeatures): number {`,
      matchLines,
      `  },`,
      `  emit(s: SpecFeatures) {`,
      `    return [{ path: s.modulePath ?? DEFAULT_PATH, content: IMPL }]`,
      `  },`,
      `})`,
      ``,
    ].join('\n')
    fs.writeFileSync(destPath, skillFile, 'utf8')
  } catch { /* persistence is best-effort — in-memory registration already succeeded */ }
}
