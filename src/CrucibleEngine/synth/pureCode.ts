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
import { deriveTests } from './derive'
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
    if (derived) {
      const v = await verify(prim.files, derived.testFile)
      if (v.accepted) return ok(prim.files, 'primitive', testsDerived, `primitive ${prim.matched.id} ✓ ${testsDerived} derived tests`, prim.matched.id)
      // primitive doesn't satisfy THIS spec variant → fall through to enumerative search
    } else {
      // No behavioral test to re-run. To ship at L0 we need POSITIVE evidence the match fits
      // the request — a bare keyword hit is not enough. Require that the spec explicitly
      // declares exports AND the emitted module is a superset of them. This closes two holes:
      //   1. A no-export prose spec (e.g. "build a React signup form with email validation")
      //      must NOT ship a keyword-matched primitive (is-email) — there is no declared API to
      //      satisfy, so we have no evidence of intent → fall through and escalate honestly.
      //   2. A wrong-API match (topoSort.ts emitting kahnSort when the spec asks for
      //      topologicalSort) is rejected by the shape superset check.
      // Specs with no declared exports and no examples are routed to L2's property-gated path,
      // which ships only on verified family-contract behavior — never on keywords alone.
      if (feats.exports.length > 0 && satisfiesExportShape(prim.files, feats.exports)) {
        return ok(prim.files, 'primitive', 0, `primitive ${prim.matched.id} (library-verified, shape-checked)`, prim.matched.id)
      }
      // no declared exports, or shape mismatch — fall through to L1/L2
    }
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
