// ============================================================================
// prove-all — Invariant 4 gate.
// Run: npm run prove:all
//
// For every skill in the manifest:
//   1. Emit the skill against a proof spec (triggers L0).
//   2. Assert the emitted exports ⊇ declared exports (shape gate).
//   3. Run the adversarial hidden suite from skills/_suites/<id>.hidden.ts.
//   4. All three must pass or the skill is UNPROVEN — fix it before shipping.
//
// This script also WRITES skills/_manifest.ts with only the proven skill IDs,
// so structuralSynthBridge always loads a consistent, validated set.
// ============================================================================

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import CATALOG from './catalogIndex'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = path.join(HERE, 'skills')
const SUITES_DIR = path.join(SKILLS_DIR, '_suites')
const OUT_ROOT = path.join(os.tmpdir(), 'crucible-prove-all')

// ── Proof specs — one per provable skill ─────────────────────────────────────
// Each spec must score ≥ 0.5 on the skill's match() AND declare the exports
// the skill emits, so the shape gate passes. The proof spec also determines
// the emitted file path (used by the suite's import).

interface ProofEntry {
  /** Skill ID as registered via registerSkill({ id }). */
  skillId: string
  /** Filename stem of the skill .ts file (without extension). */
  filename: string
  /** Minimal spec that scores ≥ 0.5 on the skill's match() and declares correct exports. */
  proofSpec: string
  /** Suite filename in SUITES_DIR. */
  suiteFile: string
}

const PROOFS: ProofEntry[] = [
  // ── 4 original core skills (suites in coding-bench/) ─────────────────────
  {
    skillId: 'graph-topology',
    filename: 'graph',
    suiteFile: path.join(HERE, '..', 'coding-bench', 'scheduler.hidden.ts'),
    proofSpec: `Topological sort and cycle detection at src/scheduler.ts.
export function topoSort(nodes:string[], edges:[string,string][]):string[]
export function findCycle(nodes:string[], edges:[string,string][]):string[]|null`,
  },
  {
    skillId: 'lru-ttl-wal-store',
    filename: 'lruTtlStore',
    suiteFile: path.join(HERE, '..', 'coding-bench', 'kvstore.hidden.ts'),
    proofSpec: `Persistent key-value store at src/kvstore.ts.
export class KVStore { constructor(opts:{maxEntries:number;walPath:string}); set(key:string,value:string,ttlMs?:number):void; get(key:string):string|undefined; delete(key:string):boolean; size():number; close():void }
LRU eviction, per-key TTL, write-ahead log, crash recovery.`,
  },
  {
    skillId: 'rate-limiter',
    filename: 'rateLimiter',
    suiteFile: path.join(HERE, '..', 'coding-bench', 'ratelimiter.hidden.ts'),
    proofSpec: `Rate limiters at src/ratelimiter.ts.
export class TokenBucket { constructor(capacity:number,refillPerSec:number,now?:()=>number); tryRemove(tokens?:number):boolean }
export class SlidingWindowLimiter { constructor(limit:number,windowMs:number,now?:()=>number); allow(key:string):boolean }`,
  },
  {
    skillId: 'regex-engine',
    filename: 'regexEngine',
    suiteFile: path.join(HERE, '..', 'coding-bench', 'regex.hidden.ts'),
    proofSpec: `Mini backtracking regex engine at src/regex.ts.
export function regexMatch(pattern:string, text:string):boolean
Literals, '.', '*', '+', '?', character classes [abc]/[a-z], backslash escaping.`,
  },
  // ── 8 new Tier-1A skills (suites in skills/_suites/) ──────────────────────
  {
    skillId: 'slug',
    filename: 'slug',
    suiteFile: path.join(SUITES_DIR, 'slug.hidden.ts'),
    proofSpec: `URL-safe slug generator at src/slug.ts.
export function slug(str:string):string
Lowercase, trim, strip non-alphanumeric, collapse and strip hyphens.`,
  },
  {
    skillId: 'chunk',
    filename: 'chunk',
    suiteFile: path.join(SUITES_DIR, 'chunk.hidden.ts'),
    proofSpec: `Split an array into fixed-size chunks at src/chunk.ts.
export function chunk<T>(arr:T[], size:number):T[][]`,
  },
  {
    skillId: 'group-by',
    filename: 'groupBy',
    suiteFile: path.join(SUITES_DIR, 'groupBy.hidden.ts'),
    proofSpec: `Group-by utility at src/groupBy.ts. Groups array elements into a Record keyed by a selector.
export function groupBy<T>(arr:T[], key:(item:T)=>string|number):Record<string,T[]>`,
  },
  {
    skillId: 'format-bytes',
    filename: 'formatBytes',
    suiteFile: path.join(SUITES_DIR, 'formatBytes.hidden.ts'),
    proofSpec: `Format a byte count as a human-readable string at src/formatBytes.ts.
export function formatBytes(bytes:number, decimals?:number):string
formatBytes(1024) === "1 KB", formatBytes(0) === "0 B"`,
  },
  {
    skillId: 'base64',
    filename: 'base64',
    suiteFile: path.join(SUITES_DIR, 'base64.hidden.ts'),
    proofSpec: `Base64 encode and decode at src/base64.ts.
export function base64Encode(str:string):string
export function base64Decode(str:string):string`,
  },
  {
    skillId: 'escape-html',
    filename: 'escapeHtml',
    suiteFile: path.join(SUITES_DIR, 'escapeHtml.hidden.ts'),
    proofSpec: `Escape and unescape HTML entities at src/escapeHtml.ts.
export function escapeHtml(str:string):string
export function unescapeHtml(str:string):string`,
  },
  {
    skillId: 'pick-omit',
    filename: 'pickOmit',
    suiteFile: path.join(SUITES_DIR, 'pickOmit.hidden.ts'),
    proofSpec: `Pick and omit object keys at src/pickOmit.ts.
export function pick<T extends object, K extends keyof T>(obj:T, keys:K[]):Pick<T,K>
export function omit<T extends object, K extends keyof T>(obj:T, keys:K[]):Omit<T,K>`,
  },
  {
    skillId: 'deep-clone',
    filename: 'deepClone',
    suiteFile: path.join(SUITES_DIR, 'deepClone.hidden.ts'),
    proofSpec: `Deep clone a value at src/deepClone.ts.
export function deepClone<T>(value:T):T
Handles nested objects, arrays, Dates, and primitives; mutations to the clone don't affect the source.`,
  },
  // ── Hand-authored Tier-1 skills (added 2026-06-30) ────────────────────────
  {
    skillId: 'deepEqual',
    filename: 'deepEqual',
    suiteFile: path.join(SUITES_DIR, 'deepEqual.hidden.ts'),
    proofSpec: `Deep structural equality check at src/module.ts.
export function deepEqual(a: unknown, b: unknown): boolean
export const isEqual: typeof deepEqual`,
  },
  {
    skillId: 'sortBy',
    filename: 'sortBy',
    suiteFile: path.join(SUITES_DIR, 'sortBy.hidden.ts'),
    proofSpec: `Sort array by key or comparator function using sortBy at src/module.ts.
export function sortBy<T>(arr: T[], key: keyof T | ((item: T) => unknown), dir?: 'asc' | 'desc'): T[]
export function orderBy<T>(arr: T[], specs: Array<{key: keyof T | ((item:T)=>unknown); dir?:'asc'|'desc'}>): T[]`,
  },
  {
    skillId: 'partition',
    filename: 'partition',
    suiteFile: path.join(SUITES_DIR, 'partition.hidden.ts'),
    proofSpec: `Partition array into two halves by predicate at src/module.ts.
export function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]]
export function partitionBy<T, K extends string | number>(arr: T[], key: (x: T) => K): Map<K, T[]>`,
  },
  {
    skillId: 'isValidators',
    filename: 'isValidators',
    suiteFile: path.join(SUITES_DIR, 'isValidators.hidden.ts'),
    proofSpec: `Validate URL, UUID, IPv4, IPv6 at src/module.ts.
export function isUrl(s: string): boolean
export function isUuid(s: string): boolean
export function isIp(s: string): boolean
export function isIpv4(s: string): boolean
export function isIpv6(s: string): boolean`,
  },
  {
    skillId: 'sanitizeHtml',
    filename: 'sanitizeHtml',
    suiteFile: path.join(SUITES_DIR, 'sanitizeHtml.hidden.ts'),
    proofSpec: `HTML sanitizer: sanitizeHtml allowlists safe tags and stripTags removes all tags at src/module.ts.
export function stripTags(html: string): string
export function sanitizeHtml(html: string, opts?: { allowedTags?: Set<string>; allowedAttrs?: Set<string> }): string`,
  },
  {
    skillId: 'jwtDecode',
    filename: 'jwtDecode',
    suiteFile: path.join(SUITES_DIR, 'jwtDecode.hidden.ts'),
    proofSpec: `JWT decode (no signature verification) at src/module.ts.
export function jwtDecode(token: string): { header: JwtHeader; payload: JwtPayload; signature: string }
export function isJwtExpired(token: string): boolean`,
  },
  {
    skillId: 'mimeType',
    filename: 'mimeType',
    suiteFile: path.join(SUITES_DIR, 'mimeType.hidden.ts'),
    proofSpec: `MIME type lookup by file extension: getMimeType, getExtension, isTextMime at src/module.ts.
export function getMimeType(fileOrExt: string): string
export function getExtension(mime: string): string | null
export function isTextMime(mime: string): boolean`,
  },
  {
    skillId: 'cronExpr',
    filename: 'cronExpr',
    suiteFile: path.join(SUITES_DIR, 'cronExpr.hidden.ts'),
    proofSpec: `Cron expression parser and validator (5-field) at src/module.ts.
export function parseCron(expr: string): CronParts
export function isCronValid(expr: string): boolean
export function describeCron(expr: string): string`,
  },
  {
    skillId: 'tomlParse',
    filename: 'tomlParse',
    suiteFile: path.join(SUITES_DIR, 'tomlParse.hidden.ts'),
    proofSpec: `TOML config parser: parseToml handles tables, arrays-of-tables, inline arrays, types at src/module.ts.
export function parseToml(src: string): Record<string, unknown>`,
  },
  // ── Catalog-generated skills (auto-derived from catalog.ts) ───────────────
  ...CATALOG.map(entry => ({
    skillId: entry.id,
    filename: entry.filename,
    suiteFile: path.join(SUITES_DIR, `${entry.filename}.hidden.ts`),
    proofSpec: [
      `${entry.summary} at ${entry.defaultPath}.`,
      entry.exports.map(e => `export function ${e}(...args: unknown[]): unknown {}`).join('\n'),
    ].join('\n'),
  })),
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function emittedExportNames(content: string): string[] {
  return Array.from(
    content.matchAll(/\bexport\s+(?:async\s+)?(?:class|function|const|interface|type)\s+([A-Za-z_$][\w$]*)/g),
    m => m[1],
  )
}

function runSuite(suiteFile: string, emitDir: string): { ok: boolean; detail: string } {
  if (!fs.existsSync(suiteFile)) return { ok: false, detail: `suite not found: ${suiteFile}` }
  const auditDir = path.join(emitDir, '__audit__')
  fs.mkdirSync(auditDir, { recursive: true })
  const dst = path.join(auditDir, path.basename(suiteFile))
  fs.copyFileSync(suiteFile, dst)
  const r = spawnSync('npx', ['tsx', dst], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const tail = out.split('\n').filter(l => /PASS|FAIL|ALL PASS|FAILURE|Error/.test(l)).slice(-5).join(' | ')
  return { ok: r.status === 0, detail: tail || out.slice(0, 200) }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Import all skill files to populate the registry (catch silently — unknown skill = fail at match step).
  await Promise.allSettled(PROOFS.map(p =>
    import(path.join(SKILLS_DIR, `${p.filename}.ts`))
  ))

  const { synthesize, extractFeatures } = await import('./index.js').catch(
    () => import('./index.ts' as string)
  ) as typeof import('./index')

  console.log('Crucible prove-all — Invariant 4 gate (zero model inference)\n')

  const provenIds: string[] = []
  const rows: string[] = []
  let passed = 0, failed = 0

  for (const proof of PROOFS) {
    const t0 = process.hrtime.bigint()
    const result = synthesize(proof.proofSpec)
    const elapsedUs = Number(process.hrtime.bigint() - t0) / 1000

    // 1. Match check
    if (!result.matched || result.matched.id !== proof.skillId) {
      const top = result.ranking[0]
      rows.push(`  FAIL  ${proof.skillId.padEnd(22)} match failed — top: ${top ? `${top.id}:${top.score.toFixed(2)}` : 'none'} (want ${proof.skillId})`)
      failed++
      continue
    }

    // 2. Shape gate
    const feats = extractFeatures(proof.proofSpec)
    const emitted = new Set(result.files.flatMap(f => emittedExportNames(f.content)))
    const missing = feats.exports.filter(e => !emitted.has(e))
    if (missing.length) {
      rows.push(`  FAIL  ${proof.skillId.padEnd(22)} shape gate — emitted {${[...emitted].join(',')}} missing {${missing.join(',')}}`)
      failed++
      continue
    }

    // 3. Suite
    const emitDir = path.join(OUT_ROOT, proof.skillId)
    fs.rmSync(emitDir, { recursive: true, force: true })
    for (const f of result.files) {
      const abs = path.join(emitDir, f.path)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, f.content)
    }

    const suite = runSuite(proof.suiteFile, emitDir)
    if (suite.ok) {
      provenIds.push(proof.filename)
      passed++
      rows.push(`  PASS  ${proof.skillId.padEnd(22)} (${elapsedUs.toFixed(0)}µs) :: ${suite.detail}`)
    } else {
      failed++
      rows.push(`  FAIL  ${proof.skillId.padEnd(22)} suite failed :: ${suite.detail}`)
    }
  }

  console.log(rows.join('\n'))

  // Write _manifest.ts with only the proven filenames
  const manifestPath = path.join(SKILLS_DIR, '_manifest.ts')
  const manifestContent = `// Auto-generated by prove-all.ts — do not edit manually.
// Every filename listed here has passed its adversarial hidden suite.
// Add a skill by: write skills/<id>.ts + skills/_suites/<id>.hidden.ts +
// proof entry in prove-all.ts, then run \`npm run prove:all\`.
export const PROVEN_SKILLS: string[] = ${JSON.stringify(provenIds, null, 2)}
`
  fs.writeFileSync(manifestPath, manifestContent)

  console.log(`
┌─ prove-all RESULT ──────────────────────────────────────────┐
│  Proven: ${String(passed).padStart(3)}   Failed: ${String(failed).padStart(3)}   Total: ${String(PROOFS.length).padStart(3)}
│  _manifest.ts updated with ${provenIds.length} skill(s).
└─────────────────────────────────────────────────────────────┘`)

  if (failed > 0) {
    console.error(`\nFAIL — ${failed} skill(s) did not prove. Fix them before shipping.`)
    process.exit(1)
  }
  console.log('\nAll skills proven. Invariant 4 holds.')
}

main()
