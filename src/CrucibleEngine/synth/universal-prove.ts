// Proof: Crucible reasons about a NOVEL task it has no primitive for — model-cost-independent —
// then DISTILLS it so the second solve is pure-code (zero model). Verified two ways:
//   (1) the spec-derived oracle accepts the proposal, and
//   (2) an independent HELD-OUT adversarial suite (coding-bench/levenshtein.hidden.ts,
//       far more cases than the spec examples) confirms true correctness.
// Run: npm run synth:universal   (needs the on-device FM daemon on :11435 for round 1)

import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { synthesizeUniversal } from './universal'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HIDDEN = path.resolve(HERE, '..', 'coding-bench', 'levenshtein.hidden.ts')

// A NOVEL spec (no matching primitive in the library) WITH worked examples so the oracle
// has something to verify against. The implementation is NOT given — it must be reasoned.
const SPEC = `Implement Levenshtein edit distance at src/levenshtein.ts.
export function editDistance(a: string, b: string): number  // minimum single-char insertions/deletions/substitutions to turn a into b
Examples:
editDistance('kitten','sitting') === 3
editDistance('cat','cot') === 1
editDistance('','abc') === 3
editDistance('flaw','lawn') === 2`

function heldOutAudit(content: string): { ok: boolean; detail: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lev-audit-'))
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src', 'levenshtein.ts'), content)
    const auditDir = path.join(dir, '__audit__')
    fs.mkdirSync(auditDir, { recursive: true })
    fs.copyFileSync(HIDDEN, path.join(auditDir, 'levenshtein.hidden.ts'))
    const r = spawnSync('npx', ['tsx', path.join(auditDir, 'levenshtein.hidden.ts')], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const tail = out.split('\n').filter(l => /PASS|FAIL|ALL PASS|FAILURE/.test(l)).slice(-3).join(' | ')
    return { ok: r.status === 0, detail: tail || out.slice(0, 160) }
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
}

async function main() {
  console.log('Crucible UNIVERSAL reasoning proof — novel task, offline, oracle-gated, self-distilling\n')

  console.log('── Round 1: no primitive exists → reason a candidate (on-device FM) → oracle-verify → distill')
  const r1 = await synthesizeUniversal(SPEC)
  console.log(`   source=${r1.source} verified=${r1.verified} fmCalls=${r1.fmCalls} testsDerived=${r1.testsDerived}`)
  console.log(`   ${r1.detail}`)
  if (!r1.verified || !r1.files.length) {
    console.error('\nFAIL — engine could not reason a verified solution for the novel task.')
    process.exit(1)
  }
  const audit1 = heldOutAudit(r1.files[0].content)
  console.log(`   HELD-OUT adversarial audit: ${audit1.ok ? 'ALL PASS' : 'FAIL'} :: ${audit1.detail}`)

  console.log('\n── Round 2: same task again → must now hit the DISTILLED pure-code primitive (zero model)')
  const r2 = await synthesizeUniversal(SPEC)
  console.log(`   source=${r2.source} verified=${r2.verified} fmCalls=${r2.fmCalls}`)
  const distilled = r2.source === 'primitive' && r2.fmCalls === 0 && r2.verified
  console.log(`   ${distilled ? 'PURE-CODE on the 2nd solve (model no longer needed)' : 'did not distill to pure-code'}`)

  const ok = r1.verified && audit1.ok && distilled
  console.log(`\n${ok ? 'PROVEN' : 'INCOMPLETE'}: reasoned a NOVEL task offline, oracle+held-out verified, and made it pure-code thereafter.`)
  process.exit(ok ? 0 : 1)
}

main().catch(e => { console.error('universal proof crashed:', e?.stack ?? e); process.exit(2) })
