// ============================================================================
// validate-batch — oracle for a SINGLE catalog JSON batch.
// Usage: npx tsx validate-batch.ts <path-to-batch.json>
//
// For each CatalogEntry in the batch:
//   1. Shape gate  — emitted exports ⊇ declared exports.
//   2. Self-match  — synthesize(proofSpec) where proofSpec = summary + stub
//      export decls must select THIS skill (id) above all others in the batch.
//   3. Suite       — run the entry's adversarial tests against its impl.
// Prints PASS/FAIL per entry and a summary. Exit 0 iff every entry passes.
//
// This is the same gate prove-all applies library-wide, scoped to one batch so
// a skill-author agent can iterate locally before shipping.
// ============================================================================

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'

interface Pattern { re: string; weight: number }
interface Test { desc: string; call: string; want: string }
interface CatalogEntry {
  id: string; filename: string; summary: string; defaultPath: string
  exports: string[]; patterns: Pattern[]; impl: string; tests: Test[]
}

const batchPath = process.argv[2]
if (!batchPath || !fs.existsSync(batchPath)) {
  console.error(`usage: npx tsx validate-batch.ts <batch.json>  (got: ${batchPath})`)
  process.exit(2)
}

let entries: CatalogEntry[]
try {
  entries = JSON.parse(fs.readFileSync(batchPath, 'utf8'))
  if (!Array.isArray(entries)) throw new Error('batch is not an array')
} catch (err) {
  console.error(`FATAL — cannot parse batch JSON: ${(err as Error).message}`)
  process.exit(2)
}

function emittedExportNames(content: string): string[] {
  return Array.from(
    content.matchAll(/\bexport\s+(?:async\s+)?(?:class|function|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g),
    m => m[1],
  )
}

function buildSuite(entry: CatalogEntry): string {
  const stem = entry.defaultPath.replace(/^src\//, '').replace(/\.ts$/, '')
  const importLine = `import { ${entry.exports.join(', ')} } from '../src/${stem}'`
  const testBlocks = entry.tests.map(t =>
    `await check(${JSON.stringify(t.desc)}, ${t.call}, ${t.want})`
  ).join('\n')
  return `${importLine}
let failures = 0
async function check(name: string, got: unknown, want: unknown) {
  got = await got
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(\`  \${ok ? 'PASS' : 'FAIL'} — \${name}\`)
  if (!ok) { console.log(\`     got \${JSON.stringify(got)} want \${JSON.stringify(want)}\`); failures++ }
}
;(async () => {
${testBlocks}
console.log(failures === 0 ? 'ALL PASS' : \`\${failures} FAILURE(S)\`)
process.exit(failures === 0 ? 0 : 1)
})()
`
}

// Lightweight self-match: does this entry's summary+exports score it highest in the batch?
function selfScore(entry: CatalogEntry, spec: string): number {
  let sc = 0
  for (const p of entry.patterns) {
    try { if (new RegExp(p.re, 'i').test(spec)) sc += p.weight } catch { /* bad regex */ }
  }
  return Math.max(0, Math.min(1, sc))
}

const OUT = path.join(os.tmpdir(), 'crucible-validate', path.basename(batchPath, '.json'))
fs.rmSync(OUT, { recursive: true, force: true })

let pass = 0
const failures: string[] = []
const seenNames = new Set<string>()

for (const entry of entries) {
  const label = entry.id ?? entry.filename ?? '?'

  // 0. structural sanity
  if (!entry.id || !entry.filename || !entry.exports?.length || !entry.impl || !entry.tests?.length || !entry.patterns?.length) {
    failures.push(`${label}: missing required fields`); continue
  }
  if (seenNames.has(entry.id) || seenNames.has(entry.filename)) {
    failures.push(`${label}: duplicate id/filename within batch`); continue
  }
  seenNames.add(entry.id); seenNames.add(entry.filename)

  // 1. shape gate
  const emitted = new Set(emittedExportNames(entry.impl))
  const missing = entry.exports.filter(e => !emitted.has(e))
  if (missing.length) { failures.push(`${label}: impl missing exports {${missing.join(',')}}`); continue }

  // 2. self-match against auto proof spec
  const proofSpec = `${entry.summary} at ${entry.defaultPath}.\n` +
    entry.exports.map(e => `export function ${e}(...args: unknown[]): unknown {}`).join('\n')
  const score = selfScore(entry, proofSpec)
  if (score < 0.5) {
    failures.push(`${label}: self-match score ${score.toFixed(2)} < 0.5 — patterns don't fire on summary+exports`); continue
  }

  // 3. run suite
  const stem = entry.defaultPath.replace(/^src\//, '').replace(/\.ts$/, '')
  const implPath = path.join(OUT, 'src', `${stem}.ts`)
  fs.mkdirSync(path.dirname(implPath), { recursive: true })
  fs.writeFileSync(implPath, entry.impl)
  const auditDir = path.join(OUT, '__audit__')
  fs.mkdirSync(auditDir, { recursive: true })
  const suitePath = path.join(auditDir, `${entry.filename}.hidden.ts`)
  fs.writeFileSync(suitePath, buildSuite(entry))

  const r = spawnSync('npx', ['tsx', suitePath], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status === 0) {
    pass++
    console.log(`  PASS  ${label}`)
  } else {
    const tail = out.split('\n').filter(l => /FAIL|Error|FAILURE/.test(l)).slice(-3).join(' | ')
    failures.push(`${label}: suite failed :: ${tail || out.slice(0, 200)}`)
  }
}

console.log(`\n── batch ${path.basename(batchPath)} ──`)
console.log(`PASS ${pass}/${entries.length}`)
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log('All entries in batch pass the oracle.')
process.exit(0)
